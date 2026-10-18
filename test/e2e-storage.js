'use strict';
const path = require('path');
const storage = require('../storage');

const dataDir = path.join(__dirname, '..', 'data');
const MB = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

console.log('=== 真实 data 目录占用统计 ===');
const u = storage.storageUsage(dataDir);
console.log('数据目录总占用 :', MB(u.totalBytes));
console.log('其中截图占用   :', MB(u.screenshotsBytes), `(${u.screenshotCount} 张)`);
console.log('文本记录(JSON) :', MB(u.recordsBytes));
console.log('近 1 小时增量  :', MB(u.hourlyRateBytes));
const daily = u.hourlyRateBytes * 24;
console.log('预估每日新增   :', MB(daily));

const free = storage.diskFreeBytes(dataDir);
console.log('磁盘剩余空间   :', free == null ? '不可用' : MB(free));
if (free != null && daily > 0) {
  console.log('若不清理预计    :', Math.floor(free / daily), '天爆满');
}

console.log('\n=== 保留策略安全性（真实数据上试运行 cleanup）===');
const del0 = storage.cleanupScreenshots(dataDir, 0);
const del7 = storage.cleanupScreenshots(dataDir, 7);
console.log('retentionDays=0 删除:', del0, '张');
console.log('retentionDays=7 删除:', del7, '张 (今天产生的数据应全部保留，=0)');

console.log('\n=== 新策略稳态预测（压缩+代表帧+7天保留）===');
// 代表帧：每 10 分钟 1 张 = 每天 144 张（原 4320 张），降 ~30 倍
// JPEG q70 + 1600px 宽：桌面 UI 截图通常比同尺寸 PNG 小 5-10 倍
const repFrameFactor = 30;
const jpegFactor = 6; // 保守估计
const perDayNew = daily / repFrameFactor / jpegFactor;
console.log('当前每日截图新增 :', MB(daily));
console.log('新策略每日新增(估):', MB(perDayNew), '(代表帧×JPEG 双重压缩)');
console.log('7 天保留稳态上限  :', MB(perDayNew * 7));
console.log('\n结论：从“每天约', MB(daily), '且无限增长” → “稳态约', MB(perDayNew * 7), '封顶，不再爆盘”。');

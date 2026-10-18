'use strict';

// 纯 Node 下的存储模块冒烟测试（不依赖 Electron）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../storage');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓', name);
}

// 用临时目录做隔离测试
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-test-'));

// 1) 文件夹与文件命名规则
const date = new Date(2026, 6, 29, 19, 6, 40); // 2026-07-29 19:06:40
assert.strictEqual(storage.monthFolderName(date), '2026-07');
assert.strictEqual(storage.hourFileName(date), '2026-07-29-19.json');
assert.strictEqual(
  storage.screenshotName(date),
  '2026-07-29-19-06-40.jpg'
);
assert.strictEqual(
  storage.screenshotName(date, 'png'),
  '2026-07-29-19-06-40.png'
);
ok('命名规则：月/小时/截屏文件名正确（默认 jpg，可指定 ext）');

// 2) 保存截屏并验证路径与存在性
const imgPath = storage.saveScreenshot(Buffer.from('fake-jpg-bytes'), tmp, date, 'jpg');
assert.ok(fs.existsSync(imgPath), '截屏文件应存在');
assert.ok(imgPath.includes(path.join('2026-07', 'screenshots')), '应落在 月/screenshots 下');
assert.ok(imgPath.endsWith('.jpg'), '默认扩展名应为 .jpg');
ok('截屏写入：落盘到 <月>/screenshots/<时间戳>.jpg');

// 3) 按小时追加记录，验证 JSON 结构与累积
const rec1 = {
  timestamp: date.toISOString(),
  imagePath: imgPath,
  model: 'qwen3-vl:4b-instruct',
  activity: '句一。句二。句三。句四。句五。',
  sentences: ['句一。', '句二。', '句三。', '句四。', '句五。'],
  analysisStatus: 'ok',
  error: null,
};
const rec2 = { ...rec1, timestamp: new Date(2026, 6, 29, 19, 7, 0).toISOString() };
storage.appendRecord(tmp, date, rec1);
storage.appendRecord(tmp, date, rec2);

const hourFile = path.join(tmp, '2026-07', '2026-07-29-19.json');
const data = JSON.parse(fs.readFileSync(hourFile, 'utf8'));
assert.strictEqual(data.date, '2026-07-29');
assert.strictEqual(data.hour, 19);
assert.strictEqual(data.records.length, 2, '应累积 2 条记录');
assert.strictEqual(data.records[0].imagePath, imgPath);
ok('按小时 JSON：结构含 date/hour/records，且多次追加正确累积');

// 4) 跨小时自动分文件
const date2 = new Date(2026, 6, 29, 20, 0, 5); // 20 点
storage.appendRecord(tmp, date2, rec1);
const hourFile2 = path.join(tmp, '2026-07', '2026-07-29-20.json');
assert.ok(fs.existsSync(hourFile2), '20 点应有独立文件');
ok('跨小时：自动创建新的小时文件');

// 5) 跨月自动分目录
const date3 = new Date(2026, 7, 1, 9, 0, 0); // 2026-08
storage.appendRecord(tmp, date3, rec1);
assert.ok(fs.existsSync(path.join(tmp, '2026-08')), '应新建 2026-08 月目录');
ok('跨月：自动创建新的月份目录');

// 6) 句子切分
const sentences = storage.splitSentences('第一句。第二句！第三句？第四句。第五句。');
assert.strictEqual(sentences.length, 5);
ok('句子切分：正确拆分为 5 句');

const fewer = storage.splitSentences('只有一句。');
assert.strictEqual(fewer.length, 1);
ok('句子切分：不足 5 句时返回实际数量');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nstorage 冒烟测试通过：${passed} 项 ✓`);

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const storage = require('../storage');

let passed = 0;
function ok(msg) {
  passed++;
  console.log('  ✓', msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-ret-'));
const month = '2026-07';
const shotDir = path.join(tmp, month, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// 一个 30 天前的旧截图 + 一个 1 小时前的新截图 + 一个 JSON 记录
const oldFile = path.join(shotDir, 'old.jpg');
const newFile = path.join(shotDir, 'new.jpg');
fs.writeFileSync(oldFile, Buffer.from('old'));
fs.writeFileSync(newFile, Buffer.from('new'));
const jsonFile = path.join(tmp, month, '2026-07-29-19.json');
fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
fs.writeFileSync(jsonFile, JSON.stringify({ records: [] }));

fs.utimesSync(oldFile, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
fs.utimesSync(newFile, new Date(now - 1 * 60 * 60 * 1000), new Date(now - 1 * 60 * 60 * 1000));

// 1) retentionDays=0 不删除
assert.strictEqual(storage.cleanupScreenshots(tmp, 0), 0, 'retentionDays=0 应不清理');
assert.ok(fs.existsSync(oldFile), 'retentionDays=0 时旧文件应保留');
ok('cleanupScreenshots(0)：永久保留不删');

// 2) retentionDays=7 删除超期旧文件，保留新文件
const deleted = storage.cleanupScreenshots(tmp, 7);
assert.strictEqual(deleted, 1, '应删除 1 个超期文件');
assert.ok(!fs.existsSync(oldFile), '旧文件应被删除');
assert.ok(fs.existsSync(newFile), '新文件应保留');
ok('cleanupScreenshots(7)：仅删超期旧截图，不碰新截图');

// 3) storageUsage 统计
const usage = storage.storageUsage(tmp);
assert.strictEqual(usage.screenshotCount, 1, '截图数应为 1');
assert.ok(usage.screenshotsBytes >= 3, '截图字节应 >= 文件大小');
assert.ok(usage.recordsBytes > 0, 'JSON 字节应 > 0');
assert.ok(usage.totalBytes >= usage.screenshotsBytes + usage.recordsBytes, 'total 应 >= 截图+记录');
ok('storageUsage：正确统计截图/记录/总量');

// 4) diskFreeBytes 返回 number 或 null（不抛）
const free = storage.diskFreeBytes(tmp);
assert.ok(free === null || typeof free === 'number', 'diskFreeBytes 返回 number 或 null');
ok('diskFreeBytes：返回剩余空间或 null（不抛错）');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nstorage-retention: ${passed} 项通过`);

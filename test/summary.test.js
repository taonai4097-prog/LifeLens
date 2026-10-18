'use strict';

// summary.js 纯 Node 冒烟测试（不依赖 Electron）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const summary = require('../summary');
const storage = require('../storage');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓', name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-sum-'));

// 1) 桶计算
const d1 = new Date(2026, 6, 29, 19, 6, 40); // -> 19:00 桶
assert.strictEqual(summary.bucketId(d1), '2026-07-29-19-00');
const d2 = new Date(2026, 6, 29, 19, 47, 0); // -> 19:40 桶
assert.strictEqual(summary.bucketId(d2), '2026-07-29-19-40');
const rng = summary.bucketRange('2026-07-29-19-00');
assert.strictEqual(rng.end - rng.start, summary.BUCKET_MS);
ok('桶计算：bucketId 按 10 分钟取整，bucketRange 跨度=10分钟');

// 2) 写入若干原始记录到小时文件（模拟 20s 截屏）
function makeRecord(ts, activity) {
  return { timestamp: ts, imagePath: 'x', model: 'm', activity, sentences: [], analysisStatus: 'ok', error: null };
}
const recA1 = makeRecord(new Date(2026, 6, 29, 19, 2, 0).toISOString(), 'A1');
const recA2 = makeRecord(new Date(2026, 6, 29, 19, 5, 0).toISOString(), 'A2');
const recB1 = makeRecord(new Date(2026, 6, 29, 19, 42, 0).toISOString(), 'B1'); // 19:40 桶
storage.appendRecord(tmp, new Date(2026, 6, 29, 19, 2, 0), recA1);
storage.appendRecord(tmp, new Date(2026, 6, 29, 19, 5, 0), recA2);
storage.appendRecord(tmp, new Date(2026, 6, 29, 19, 42, 0), recB1);
ok('准备：向 19:00 / 19:40 两个桶写入原始记录');

// 3) getRecordsInBucket 正确按桶过滤
const inA = summary.getRecordsInBucket(tmp, '2026-07-29-19-00');
const inB = summary.getRecordsInBucket(tmp, '2026-07-29-19-40');
assert.strictEqual(inA.length, 2);
assert.strictEqual(inB.length, 1);
ok('getRecordsInBucket：仅返回所属 10 分钟桶内的记录');

// 4) 保存汇总 + 读取
const sumA = {
  bucket: '2026-07-29-19-00',
  startTime: rng.start.toISOString(),
  endTime: rng.end.toISOString(),
  project: '写《2026年中报告》',
  category: '工作',
  description: '用户在写年中报告……',
  software: ['Word', 'Chrome'],
  todos: ['发给老板'],
  status: 'ok',
  error: null,
  recordCount: 2,
};
summary.saveSummary(tmp, sumA);
const daySums = summary.loadDaySummaries(tmp, new Date(2026, 6, 29));
assert.strictEqual(daySums['2026-07-29-19-00'].project, '写《2026年中报告》');
ok('saveSummary / loadDaySummaries：按天文件持久化与读取');

// 5) collectBacklog：19:40 桶有记录但无汇总 -> 应被扫出；19:00 已汇总 -> 不扫
const backlog = summary.collectBacklog(tmp, new Date(2026, 6, 29, 20, 0, 0));
assert.ok(backlog.includes('2026-07-29-19-40'), '应发现 19:40 待汇总');
assert.ok(!backlog.includes('2026-07-29-19-00'), '已汇总的桶不应再次出现');
ok('collectBacklog：找出有记录未汇总的桶，已汇总的排除');

// 6) getHeatmap：含 done / pending / empty 状态
const heat = summary.getHeatmap(tmp, { hours: 1, to: new Date(2026, 6, 29, 19, 50, 0), now: new Date(2026, 6, 29, 20, 0, 0) });
const done = heat.find((c) => c.bucket === '2026-07-29-19-00');
const pending = heat.find((c) => c.bucket === '2026-07-29-19-40');
assert.strictEqual(done.status, 'done');
assert.strictEqual(done.category, '工作');
assert.strictEqual(pending.status, 'pending');
ok('getHeatmap：正确标注 done(带分类)/pending(待汇总)');

// 7) querySummaries 分页 + 过滤
const q = summary.querySummaries(tmp, { project: '年中报告', limit: 10, offset: 0 });
assert.strictEqual(q.total, 1);
assert.strictEqual(q.items[0].category, '工作');
const qNone = summary.querySummaries(tmp, { project: '不存在的项目XYZ' });
assert.strictEqual(qNone.total, 0);
ok('querySummaries：按项目关键字过滤，分页返回');

// 8) getFilterOptions
const opts = summary.getFilterOptions(tmp);
assert.ok(opts.projects.includes('写《2026年中报告》'));
assert.ok(opts.software.includes('Word'));
ok('getFilterOptions：汇总去重出项目与软件列表');

// 9) parseSummaryResponse：从模型文本提取 JSON 并规范化
const parsed = summary.parseSummaryResponse(
  '好的，以下是：\n{"project":"玩《原神》","category":"娱乐","description":"打副本","software":["游戏"],"todos":[]}\n以上。'
);
assert.strictEqual(parsed.project, '玩《原神》');
assert.strictEqual(parsed.category, '娱乐');
assert.deepStrictEqual(parsed.software, ['游戏']);
ok('parseSummaryResponse：容错提取 JSON、规范化字段');

// 非法 category 回退“其他”
const badCat = summary.parseSummaryResponse('{"project":"x","category":"睡觉","description":"d","software":[],"todos":[]}');
assert.strictEqual(badCat.category, '其他');
ok('parseSummaryResponse：非法分类回退为“其他”');

// 9b) 跨月 backlog：在上一月目录写入“有记录未汇总”的桶，应被扫出
const recJune = makeRecord(new Date(2026, 5, 30, 23, 52, 0).toISOString(), 'June');
storage.appendRecord(tmp, new Date(2026, 5, 30, 23, 52, 0), recJune); // -> 2026-06/...-23.json
const backlog2 = summary.collectBacklog(tmp, new Date(2026, 6, 30, 0, 0, 0)); // 6月末与7月末的桶均已结束
assert.ok(backlog2.includes('2026-06-30-23-50'), '跨月：上一月末尾未汇总桶应被扫出');
assert.ok(backlog2.includes('2026-07-29-19-40'), '本月的待汇总桶仍应被扫出');
ok('collectBacklog：扫描全部月份目录，跨月桶不漏');

// 9c) parseSummaryResponse：```json 围栏 + 模型夹带额外花括号（贪婪正则会误合并而失败的场景）
const fenced = summary.parseSummaryResponse(
  '```json\n{"project":"看《繁花》","category":"娱乐","description":"追剧","software":["电视"],"todos":[]}\n```'
);
assert.strictEqual(fenced.project, '看《繁花》');
const stray = summary.parseSummaryResponse(
  '结果：{"project":"x","category":"工作","description":"d","software":[],"todos":[]} 备注：{请忽略这段}'
);
assert.strictEqual(stray.project, 'x');
ok('parseSummaryResponse：括号平衡提取，正确处理围栏/夹带花括号');

// 9d) querySummaries：真正按 from/to 时间过滤（局部时间段）
const qAll = summary.querySummaries(tmp, {});
assert.ok(qAll.total >= 1, '无过滤应至少含 1 条');
const qWindow = summary.querySummaries(tmp, {
  from: '2026-07-29T19:30:00',
  to: '2026-07-29T19:59:59',
});
assert.strictEqual(qWindow.total, 0, '19:00 桶早于 from(19:30) 应被时间过滤排除');
const qWindow2 = summary.querySummaries(tmp, {
  from: '2026-07-29T19:00:00',
  to: '2026-07-29T19:59:59',
});
assert.strictEqual(qWindow2.total, 1, '包含 19:00 桶的时间窗应命中 1 条');
ok('querySummaries：按 from/to 时间戳精确过滤');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nsummary 冒烟测试通过：${passed} 项 ✓`);

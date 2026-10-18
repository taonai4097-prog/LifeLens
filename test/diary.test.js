'use strict';

// diary.js 冒烟测试：JSON 解析健壮、上下文截断、跨月 backlog、月历标记

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const diary = require('../diary');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓', name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-diary-'));

function writeJson(rel, obj) {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
}

// ---- 解析：普通 JSON ----
(function testParsePlain() {
  const r = diary.parseDiaryResponse(
    '{"brief":"今天不错","mainItems":["a","b","c"],"highlights":["h"],"todos":[],"suggestions":["s"],"tips":"喝水"}'
  );
  assert.strictEqual(r.brief, '今天不错');
  assert.strictEqual(r.mainItems.length, 3);
  assert.strictEqual(r.tips, '喝水');
  ok('parseDiaryResponse 普通 JSON 正常');
})();

// ---- 解析：夹带 ```json 围栏与多余文字 ----
(function testParseFenced() {
  const text =
    '好的，这是日记。\n```json\n{"brief":"一天","mainItems":["x","y","z"],"highlights":["g"],"todos":["t"],"suggestions":["k"],"tips":"休息"}\n```\n以上。';
  const r = diary.parseDiaryResponse(text);
  assert.strictEqual(r.brief, '一天');
  assert.strictEqual(r.mainItems.length, 3);
  assert.strictEqual(r.tips, '休息');
  ok('parseDiaryResponse 正确处理 ```json 围栏');
})();

// ---- 解析：字段缺失/类型异常兜底 ----
(function testParseCoerce() {
  const r = diary.parseDiaryResponse('{"brief":123,"mainItems":"不是数组","highlights":[1,2]}');
  assert.strictEqual(typeof r.brief, 'string');
  assert.deepStrictEqual(r.mainItems, []);
  assert.strictEqual(r.highlights.length, 0); // 数字被过滤
  ok('parseDiaryResponse 对异常字段做兜底');
})();

// ---- 上下文组装与截断 ----
(function testBuildContext() {
  const sums = {};
  for (let i = 0; i < 200; i++) {
    const b = `2026-07-29-${String(Math.floor(i / 6)).padStart(2, '0')}-${String((i % 6) * 10).padStart(2, '0')}`;
    sums[b] = {
      status: 'ok',
      project: '开发 LifeLens',
      category: '工作',
      software: ['VS Code'],
      description: 'x'.repeat(200),
    };
  }
  const ctx = diary.buildDiaryContext(sums);
  assert.ok(ctx.length <= 24000 + 200, '上下文被截断');
  assert.ok(ctx.includes('开发 LifeLens'), '上下文含项目名');
  ok('buildDiaryContext 截断且不超长');
})();

// ---- 跨月 backlog 扫描 ----
(function testBacklogCrossMonth() {
  // 6 月：有 ok 汇总、无日记 -> 应被扫出
  writeJson('2026-06/summaries-2026-06-30.json', {
    date: '2026-06-30',
    summaries: { '2026-06-30-09-00': { status: 'ok', category: '工作', project: 'p' } },
  });
  // 7 月：有 ok 汇总 + 已有日记 -> 不应被扫出
  writeJson('2026-07/summaries-2026-07-29.json', {
    date: '2026-07-29',
    summaries: { '2026-07-29-09-00': { status: 'ok', category: '工作', project: 'p' } },
  });
  writeJson('2026-07/diaries-2026-07-29.json', {
    date: '2026-07-29',
    status: 'ok',
    brief: '日记',
  });
  // 7 月：只有 error 汇总（无 ok） -> 不应被扫出
  writeJson('2026-07/summaries-2026-07-30.json', {
    date: '2026-07-30',
    summaries: { '2026-07-30-09-00': { status: 'error', category: null } },
  });

  const missing = diary.collectDiaryBacklog(tmp);
  assert.deepStrictEqual(missing, ['2026-06-30'], '仅未生成且含 ok 汇总的日期被扫出');
  ok('collectDiaryBacklog 跨月扫描 + 仅含 ok 汇总才入队');
})();

// ---- 月历标记 ----
(function testMonthMarkers() {
  writeJson('2026-07/summaries-2026-07-29.json', { date: '2026-07-29', summaries: {} });
  writeJson('2026-07/diaries-2026-07-29.json', { date: '2026-07-29', status: 'ok' });
  writeJson('2026-07/summaries-2026-07-30.json', { date: '2026-07-30', summaries: {} });
  const marks = diary.getMonthMarkers(tmp, 2026, 7);
  assert.strictEqual(marks['29'].hasSummary, true);
  assert.strictEqual(marks['29'].hasDiary, true);
  assert.strictEqual(marks['30'].hasSummary, true);
  assert.strictEqual(marks['30'].hasDiary, undefined);
  ok('getMonthMarkers 正确标记有记录/有日记');
})();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ndiary: ${passed} 项通过`);

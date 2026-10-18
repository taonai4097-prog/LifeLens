'use strict';

// analytics.js 冒烟测试：范围解析 + 看板聚合（纯本地，无需模型）

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const analytics = require('../analytics');
const summary = require('../summary');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓', name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-analytics-'));

function writeDay(dateStr, summaries) {
  const file = path.join(tmp, dateStr.slice(0, 7), `summaries-${dateStr}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date: dateStr, summaries }));
}

function mkBucket(cat, project, software) {
  return { status: 'ok', category: cat, project, software, description: 'x' };
}

// ---- 范围解析 ----
(function testResolveRange() {
  const day = analytics.resolveRange('day', '2026-07-29');
  assert.strictEqual(day.type, 'day');
  assert.strictEqual(day.label, '2026-07-29');
  // 周日 ~ 下一日（不含）
  const end = new Date(day.end);
  assert.strictEqual(end.getDate(), 30);

  const week = analytics.resolveRange('week', '2026-07-29'); // 周三 -> 本周一 7/27
  assert.strictEqual(week.type, 'week');
  assert.strictEqual(week.start.getDate(), 27);
  assert.strictEqual(new Date(week.end).getDate(), 3); // 8/3 不含

  const month = analytics.resolveRange('month', '2026-07-15');
  assert.strictEqual(month.start.getDate(), 1);
  assert.strictEqual(new Date(month.end).getMonth(), 7); // 8月

  const year = analytics.resolveRange('year', '2026-07-15');
  assert.strictEqual(year.start.getMonth(), 0);
  assert.strictEqual(new Date(year.end).getFullYear(), 2027);
  ok('resolveRange day/week/month/year 边界正确');
})();

// ---- 看板聚合 ----
(function testDashboard() {
  writeDay('2026-07-29', {
    '2026-07-29-09-00': mkBucket('工作', '开发 LifeLens', ['VS Code', '终端']),
    '2026-07-29-09-10': mkBucket('工作', '开发 LifeLens', ['VS Code']),
    '2026-07-29-10-00': mkBucket('娱乐', '玩《原神》', ['原神']),
    '2026-07-29-10-10': mkBucket('娱乐', '玩《原神》', ['原神', 'Discord']),
    '2026-07-29-14-00': mkBucket('学习', '学英语', ['Anki']),
    // 一条 pending（无分类）应被忽略
    '2026-07-29-15-00': { status: 'pending', category: null, project: '', software: [] },
  });

  const d = analytics.getDashboard(tmp, 'day', '2026-07-29');
  assert.strictEqual(d.totals.bucketCount, 5, 'bucketCount=5');
  assert.strictEqual(d.totals.minutes, 50, 'minutes=50');
  assert.strictEqual(d.categoryMinutes['工作'], 20);
  assert.strictEqual(d.categoryMinutes['娱乐'], 20);
  assert.strictEqual(d.categoryMinutes['学习'], 10);
  assert.strictEqual(d.totals.uncategorizedMinutes, 0);
  ok('categoryMinutes / 总时长正确（pending 被忽略）');

  const sw = d.softwareCounts.find((x) => x.name === '原神');
  assert.ok(sw && sw.count === 2, '原神 出现 2 次');
  const vsc = d.softwareCounts.find((x) => x.name === 'VS Code');
  assert.ok(vsc && vsc.count === 2, 'VS Code 出现 2 次');
  ok('softwareCounts 频次统计正确');

  const proj = d.projectMinutes.find((x) => x.project === '开发 LifeLens');
  assert.ok(proj && proj.minutes === 20, '开发 LifeLens 专注 20 分钟');
  ok('projectMinutes 专注时长正确');

  assert.strictEqual(d.timeSeries.length, 24, 'day 时间序列 24 个周期');
  const h9 = d.timeSeries.find((p) => p.label === '09:00');
  assert.strictEqual(h9['工作'], 20, '09:00 工作 20 分钟');
  ok('timeSeries 按小时堆叠正确');

  // 按月聚合也能覆盖到这一天
  const m = analytics.getDashboard(tmp, 'month', '2026-07-15');
  assert.strictEqual(m.totals.bucketCount, 5, 'month 聚合覆盖当天');
  ok('按月聚合覆盖相关月份');
})();

// ---- 空数据兜底 ----
(function testEmpty() {
  const d = analytics.getDashboard(tmp, 'day', '2030-01-01');
  assert.strictEqual(d.totals.bucketCount, 0);
  assert.strictEqual(d.timeSeries.length, 24);
  assert.strictEqual(d.softwareCounts.length, 0);
  ok('空范围返回零值且不抛错');
})();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nanalytics: ${passed} 项通过`);

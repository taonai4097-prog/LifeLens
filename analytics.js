'use strict';

// 看板（多维可视化）聚合模块：纯本地计算，不调用模型。
// 输入一段范围（day/week/month/year）+ 参考日期，扫描该范围内的 summaries 文件，
// 输出分类时长占比、软件出现频次、项目专注时长、按周期的时间序列等结构化数据，供图表渲染。

const fs = require('fs');
const path = require('path');
const summary = require('./summary');

const CATEGORY_SET = ['娱乐', '工作', '学习', '社交', '其他'];

function pad2(n) {
  return String(n).padStart(2, '0');
}
function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function zeroCat() {
  return { 娱乐: 0, 工作: 0, 学习: 0, 社交: 0, 其他: 0 };
}

// 解析范围：type ∈ day|week|month|year；value 为参考日期 YYYY-MM-DD（缺省=今天）
// 返回 { type, start(含), end(不含), label }
function resolveRange(type, value) {
  const ref = value ? new Date(value + 'T00:00:00') : new Date();
  if (isNaN(ref.getTime())) {
    const t = new Date();
    return resolveRange(type, dayKey(t));
  }
  let start;
  let end;
  let label;
  if (type === 'week') {
    // 周一为一周起点
    const dow = (ref.getDay() + 6) % 7; // 0=周一
    start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - dow, 0, 0, 0, 0);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 0, 0, 0, 0);
    label = `${dayKey(start)} ~ ${dayKey(new Date(end.getTime() - 1))}（本周）`;
  } else if (type === 'month') {
    start = new Date(ref.getFullYear(), ref.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1, 0, 0, 0, 0);
    label = `${ref.getFullYear()}年${ref.getMonth() + 1}月`;
  } else if (type === 'year') {
    start = new Date(ref.getFullYear(), 0, 1, 0, 0, 0, 0);
    end = new Date(ref.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
    label = `${ref.getFullYear()}年`;
  } else {
    start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 0, 0, 0, 0);
    end = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1, 0, 0, 0, 0);
    label = dayKey(ref);
  }
  return { type, start, end, label };
}

// 生成该范围下的“周期”序列（时间轴）
function buildPeriods(range) {
  const periods = [];
  if (range.type === 'day') {
    for (let h = 0; h < 24; h++) {
      periods.push({ key: String(h), label: `${pad2(h)}:00`, order: h });
    }
  } else if (range.type === 'week') {
    const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + i);
      periods.push({ key: String(i), label: names[i], order: i, date: dayKey(d) });
    }
  } else if (range.type === 'month') {
    let d = new Date(range.start);
    while (d < range.end) {
      periods.push({ key: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, order: periods.length, date: dayKey(d) });
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
  } else {
    for (let m = 0; m < 12; m++) {
      periods.push({ key: String(m), label: `${m + 1}月`, order: m });
    }
  }
  return periods;
}

// 一个桶的起始时间属于哪个周期 key
function periodKeyOf(range, date) {
  if (range.type === 'day') return String(date.getHours());
  if (range.type === 'week') return String((date.getDay() + 6) % 7);
  if (range.type === 'month') return dayKey(date);
  if (range.type === 'year') return String(date.getMonth());
  return null;
}

function topCategory(catMinutes) {
  let best = null;
  let bv = -1;
  for (const k of CATEGORY_SET) {
    if (catMinutes[k] > bv) {
      bv = catMinutes[k];
      best = k;
    }
  }
  return bv > 0 ? best : null;
}

// 聚合：扫描范围内相关月份的 summaries-*.json，统计各类指标
function aggregate(dataDir, range) {
  const periods = buildPeriods(range);
  const ts = {};
  periods.forEach((p) => {
    ts[p.key] = { cats: zeroCat(), total: 0 };
  });

  const catMinutes = zeroCat();
  const categoryBuckets = zeroCat();
  const softwareCounts = {};
  const projectMinutes = {};
  const daysWithData = new Set();

  // 收集范围内的月份目录（避免逐日全量扫描）
  const months = new Set();
  let d = new Date(range.start);
  while (d < range.end) {
    months.add(monthKey(d));
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }

  for (const mk of months) {
    const dir = path.join(dataDir, mk);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^summaries-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const f of files) {
      const dateStr = f.replace('summaries-', '').replace('.json', '');
      const dd = new Date(dateStr + 'T00:00:00');
      if (dd < range.start || dd >= range.end) continue;
      const sums = summary.loadDaySummaries(dataDir, dd);
      daysWithData.add(dateStr);
      for (const b of Object.keys(sums)) {
        const s = sums[b];
        if (s.status !== 'ok') continue;
        const bs = summary.bucketStart(b);
        const key = periodKeyOf(range, bs);
        const cat = CATEGORY_SET.includes(s.category) ? s.category : '其他';
        catMinutes[cat] += 10;
        categoryBuckets[cat] += 1;
        const pentry = ts[key];
        if (pentry) {
          pentry.cats[cat] += 10;
          pentry.total += 10;
        }
        (s.software || []).forEach((sw) => {
          softwareCounts[sw] = (softwareCounts[sw] || 0) + 1;
        });
        if (s.project) {
          if (!projectMinutes[s.project]) {
            projectMinutes[s.project] = { project: s.project, minutes: 0, buckets: 0, category: cat };
          }
          projectMinutes[s.project].minutes += 10;
          projectMinutes[s.project].buckets += 1;
          projectMinutes[s.project].category = cat;
        }
      }
    }
  }

  const categorizedMinutes = Object.values(catMinutes).reduce((a, b) => a + b, 0);
  const bucketCount = Object.values(categoryBuckets).reduce((a, b) => a + b, 0);
  const uncategorizedMinutes = Math.max(0, bucketCount * 10 - categorizedMinutes);

  const softwareArr = Object.keys(softwareCounts)
    .map((n) => ({ name: n, count: softwareCounts[n] }))
    .sort((a, b) => b.count - a.count);
  const projectArr = Object.keys(projectMinutes)
    .map((k) => projectMinutes[k])
    .sort((a, b) => b.minutes - a.minutes);

  const timeSeries = periods
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => {
      const e = ts[p.key] || { cats: zeroCat(), total: 0 };
      return { key: p.key, label: p.label, order: p.order, total: e.total, ...e.cats };
    });

  return {
    scope: {
      type: range.type,
      label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    totals: {
      bucketCount,
      categorizedCount: bucketCount,
      minutes: bucketCount * 10,
      categorizedMinutes,
      uncategorizedMinutes,
      daysWithData: daysWithData.size,
      distinctSoftware: softwareArr.length,
      distinctProjects: projectArr.length,
      topCategory: topCategory(catMinutes),
    },
    categoryMinutes: catMinutes,
    categoryBuckets: categoryBuckets,
    softwareCounts: softwareArr,
    projectMinutes: projectArr,
    timeSeries,
    categorySet: CATEGORY_SET,
  };
}

function getDashboard(dataDir, type, value) {
  const range = resolveRange(type || 'day', value);
  return aggregate(dataDir, range);
}

module.exports = {
  CATEGORY_SET,
  resolveRange,
  buildPeriods,
  getDashboard,
};

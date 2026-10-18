'use strict';

// 十分钟汇总模块：桶计算、记录聚合、汇总文件读写、backlog 扫描、
// 时间线分页查询、热力图数据、筛选选项，以及与 Ollama 的结构化汇总调用。

const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const { withModelGate, buildModelOptions } = require('./ollamaClient');

const BUCKET_MS = 10 * 60 * 1000; // 10 分钟
const CATEGORIES = ['娱乐', '工作', '学习', '社交'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 桶 id：YYYY-MM-DD-HH-MM（MM 为 0/10/20/30/40/50）
function bucketId(date) {
  const d = new Date(date);
  const m = Math.floor(d.getMinutes() / 10) * 10;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(
    d.getHours()
  )}-${pad2(m)}`;
}

function bucketStart(bucketId) {
  const [Y, M, D, H, Min] = bucketId.split('-').map(Number);
  return new Date(Y, M - 1, D, H, Min, 0, 0);
}

function bucketRange(bucketId) {
  const start = bucketStart(bucketId);
  return { start, end: new Date(start.getTime() + BUCKET_MS) };
}

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 某天的汇总文件：data/<YYYY-MM>/summaries-YYYY-MM-DD.json
// 结构：{ "date":"...", "summaries": { "<bucketId>": {...} } }
function summariesDayFile(dataDir, date) {
  const d = new Date(date);
  return path.join(
    dataDir,
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
    `summaries-${dayKey(d)}.json`
  );
}

function loadDaySummaries(dataDir, date) {
  const data = storage.readJson(summariesDayFile(dataDir, date));
  if (data && data.summaries && typeof data.summaries === 'object') return data.summaries;
  return {};
}

function saveSummary(dataDir, summary) {
  const start = bucketStart(summary.bucket);
  const file = summariesDayFile(dataDir, start);
  let data = storage.readJson(file) || { date: dayKey(start), summaries: {} };
  if (!data.summaries) data.summaries = {};
  data.summaries[summary.bucket] = summary;
  storage.ensureDir(path.dirname(file));
  storage.writeJsonAtomic(file, data);
}

// 读取某 10 分钟桶内的所有原始记录
function getRecordsInBucket(dataDir, bucketId) {
  const { start, end } = bucketRange(bucketId);
  const records = storage.readHourRecords(dataDir, start);
  const startMs = start.getTime();
  const endMs = end.getTime();
  return records.filter((r) => {
    const t = new Date(r.timestamp).getTime();
    return t >= startMs && t < endMs;
  });
}

// 扫描 dataDir 下【所有月份】的小时文件，找出“有记录但未汇总”的桶（end <= now），按时间升序返回桶 id。
// 注意：必须扫描全部 YYYY-MM 目录，而非仅当前月——否则月初时上一月末尾的
// 未汇总桶会被永久漏掉（数据完整性缺陷）。
function collectBacklog(dataDir, now) {
  const nowMs = now.getTime();
  if (!fs.existsSync(dataDir)) return [];
  const monthDirs = fs
    .readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}$/.test(f))
    .map((f) => path.join(dataDir, f));

  const missing = new Set();
  for (const monthDir of monthDirs) {
    const entries = fs.readdirSync(monthDir);
    const hourFiles = entries.filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(f));
    const summaryFiles = entries.filter((f) => /^summaries-\d{4}-\d{2}-\d{2}\.json$/.test(f));

    // 预载该月每天的汇总，避免重复读
    const dayMap = {};
    for (const sf of summaryFiles) {
      const data = storage.readJson(path.join(monthDir, sf));
      if (data && data.summaries) dayMap[data.date] = data.summaries;
    }

    for (const hf of hourFiles) {
      const data = storage.readJson(path.join(monthDir, hf));
      const recs = data && Array.isArray(data.records) ? data.records : [];
      for (const r of recs) {
        const b = bucketId(new Date(r.timestamp));
        const { end } = bucketRange(b);
        if (end.getTime() <= nowMs) {
          const day = dayMap[dayKey(bucketStart(b))] || {};
          if (!day[b]) missing.add(b);
        }
      }
    }
  }
  return Array.from(missing).sort();
}

// 时间线分页查询（最近 -> 旧）。支持按 project 关键字、software 精确匹配、日期范围过滤。
function querySummaries(dataDir, opts = {}) {
  const {
    from,
    to,
    project,
    software,
    limit = 50,
    offset = 0,
    sort = 'desc',
    maxDays = 180,
  } = opts;
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : null;
  const fromDay = fromDate
    ? new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate())
    : null;
  const fromMs = fromDate ? fromDate.getTime() : null;
  const toMs = toDate ? toDate.getTime() : null;

  const items = [];
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() - i);
    if (fromDay && d < fromDay) break;
    const sums = loadDaySummaries(dataDir, d);
    for (const b of Object.keys(sums)) {
      const s = sums[b];
      if (project && !(s.project || '').includes(project)) continue;
      if (software && !(s.software || []).includes(software)) continue;
      // 真正按 from/to 时间戳过滤（不仅是按天循环），支持局部时间段查询
      const t = bucketStart(b).getTime();
      if (fromMs !== null && t < fromMs) continue;
      if (toMs !== null && t > toMs) continue;
      items.push(s);
    }
  }

  items.sort((a, b) =>
    sort === 'asc'
      ? a.bucket.localeCompare(b.bucket)
      : b.bucket.localeCompare(a.bucket)
  );
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { total, items: page, hasMore: offset + limit < total };
}

// 热力图数据：返回最近 hours 小时里每个 10 分钟桶的状态
// status: 'done'(已汇总,带category) | 'pending'(有记录待汇总) | 'empty'(无数据)
// now：用于判断“桶是否已结束”的参考时间（默认当前时间；测试可注入）
function getHeatmap(dataDir, opts = {}) {
  const { hours = 24, to = new Date(), now = new Date() } = opts;
  const toDate = new Date(to);
  const endStart = bucketStart(bucketId(toDate));
  const totalBuckets = Math.max(1, Math.round((hours * 60) / 10));

  const bucketStarts = [];
  for (let i = totalBuckets - 1; i >= 0; i--) {
    bucketStarts.push(new Date(endStart.getTime() - i * BUCKET_MS));
  }

  // 按小时/按天缓存读取，避免重复 IO
  const hourCache = {};
  const getHourRecs = (date) => {
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
      date.getDate()
    )}-${pad2(date.getHours())}`;
    if (!(key in hourCache)) hourCache[key] = storage.readHourRecords(dataDir, date);
    return hourCache[key];
  };
  const dayCache = {};
  const getDaySum = (date) => {
    const key = dayKey(date);
    if (!(key in dayCache)) dayCache[key] = loadDaySummaries(dataDir, date);
    return dayCache[key];
  };

  const nowMs = now.getTime();
  return bucketStarts.map((start) => {
    const b = bucketId(start);
    const { end } = bucketRange(b);
    const sum = getDaySum(start)[b];
    let status = 'empty';
    let category = null;
    let recordCount = 0;
    if (sum) {
      status = 'done';
      category = sum.category;
      recordCount = sum.recordCount || 0;
    } else {
      const startMs = start.getTime();
      const endMs = end.getTime();
      const recs = getHourRecs(start).filter((r) => {
        const t = new Date(r.timestamp).getTime();
        return t >= startMs && t < endMs;
      });
      recordCount = recs.length;
      if (recordCount > 0 && endMs <= nowMs) status = 'pending';
    }
    return {
      bucket: b,
      start: start.toISOString(),
      end: end.toISOString(),
      status,
      category,
      recordCount,
    };
  });
}

// 筛选选项：去重的 project 与 software 列表
function getFilterOptions(dataDir, opts = {}) {
  const { maxDays = 180, to = new Date() } = opts;
  const toDate = new Date(to);
  const projects = new Set();
  const software = new Set();
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() - i);
    const sums = loadDaySummaries(dataDir, d);
    for (const b of Object.keys(sums)) {
      const s = sums[b];
      if (s.project) projects.add(s.project);
      (s.software || []).forEach((x) => software.add(x));
    }
  }
  return {
    projects: Array.from(projects).sort(),
    software: Array.from(software).sort(),
  };
}

// 桶详情：汇总 + 该桶内原始记录
function getBucketDetail(dataDir, bucketId) {
  const start = bucketStart(bucketId);
  const summary = loadDaySummaries(dataDir, start)[bucketId] || null;
  const records = getRecordsInBucket(dataDir, bucketId);
  return { summary, records };
}

// ---------- 与 Ollama 的结构化汇总调用 ----------

// 从模型文本中提取第一个“括号平衡”的 JSON 对象。
// 不依赖贪婪正则 /\{[\s\S]*\}/（它会在文本夹带多个花括号或 ```json 围栏时误合并），
// 而是逐字符扫描，正确处理字符串内的花括号/转义，返回第一个配平的 {...} 片段。
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 从模型文本中提取第一个 JSON 对象并解析、规范化
function parseSummaryResponse(text) {
  if (!text || typeof text !== 'string') throw new Error('模型返回为空');
  const raw = extractJsonObject(text);
  if (!raw) throw new Error('模型返回中未找到 JSON');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error('模型返回的 JSON 解析失败：' + e.message);
  }
  const category = CATEGORIES.includes(obj.category) ? obj.category : '其他';
  // 落库前防御性清洗：剥离替换符 U+FFFD，避免乱码沉淀进汇总
  const clean = (s) => sanitize(typeof s === 'string' ? s.trim() : '');
  return {
    project: clean(obj.project),
    category,
    description: clean(obj.description),
    software: Array.isArray(obj.software)
      ? obj.software.map((x) => clean(x)).filter(Boolean)
      : [],
    todos: Array.isArray(obj.todos)
      ? obj.todos.map((x) => clean(x)).filter(Boolean)
      : [],
  };
}

// 剥离替换符 U+FFFD（解码失败残留），正常中文/emoji 不受影响
function sanitize(s) {
  if (!s) return '';
  return String(s).replace(/�/g, '').trim();
}

async function generateSummary(cfg, bucketId, records, previousSummary) {
  const prevText = previousSummary
    ? JSON.stringify(
        { project: previousSummary.project, category: previousSummary.category },
        null,
        2
      )
    : '（无，这是第一个窗口）';
  const recordsText = records
    .map((r, i) => `【${i + 1}】${r.activity || ''}`)
    .join('\n');

  const userPrompt = (cfg.summaryUserPrompt || '')
    .replace('{{PREV}}', prevText)
    .replace('{{RECORDS}}', recordsText || '（该窗口无截屏记录）');

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: cfg.summarySystemPrompt || '' },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    format: 'json',
    options: buildModelOptions(cfg, 0.4),
  };

  const base = (cfg.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const res = await withModelGate(() =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.summaryTimeoutMs || 120000),
    })
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = (data && data.message && data.message.content) || '';
  const parsed = parseSummaryResponse(content);
  const { start, end } = bucketRange(bucketId);
  return {
    bucket: bucketId,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    project: parsed.project,
    category: parsed.category,
    description: parsed.description,
    software: parsed.software,
    todos: parsed.todos,
    status: 'ok',
    error: null,
    recordCount: records.length,
  };
}

module.exports = {
  BUCKET_MS,
  CATEGORIES,
  bucketId,
  bucketStart,
  bucketRange,
  loadDaySummaries,
  saveSummary,
  getRecordsInBucket,
  collectBacklog,
  querySummaries,
  getHeatmap,
  getFilterOptions,
  getBucketDetail,
  parseSummaryResponse,
  generateSummary,
};

'use strict';

// 日记（二阶汇总）模块：基于“某一天所有 10 分钟结构化汇总”再让模型做一次总结，
// 产出面向人的当日日记。包含：简短总结、主要事项（三件）、高光、待办、优化建议、温馨提示。
// 同时提供跨月 backlog 扫描（与 summary.collectBacklog 同级的完整性保证）与月历标记。

const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const summary = require('./summary');
const { withModelGate, buildModelOptions } = require('./ollamaClient');

function pad2(n) {
  return String(n).padStart(2, '0');
}
function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 某天的日记文件：data/<YYYY-MM>/diaries-YYYY-MM-DD.json
function diaryDayFile(dataDir, date) {
  const d = new Date(date);
  return path.join(
    dataDir,
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
    `diaries-${dayKey(d)}.json`
  );
}

function loadDayDiary(dataDir, date) {
  const data = storage.readJson(diaryDayFile(dataDir, date));
  if (data && data.status === 'ok') return data;
  return null;
}

function saveDiary(dataDir, diary) {
  const file = diaryDayFile(dataDir, diary.date);
  storage.ensureDir(path.dirname(file));
  storage.writeJsonAtomic(file, diary);
}

// 扫描 dataDir 下【所有月份】，找出“有 ok 汇总但无日记”的日期（升序返回 YYYY-MM-DD）。
// 必须扫全部月份——否则月初时上一月末尾的未生成日记会被永久漏掉（与 collectBacklog 同级缺陷）。
function collectDiaryBacklog(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  const monthDirs = fs
    .readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}$/.test(f))
    .map((f) => path.join(dataDir, f));

  const missing = new Set();
  for (const monthDir of monthDirs) {
    const entries = fs.readdirSync(monthDir);
    const summaryFiles = entries.filter((f) => /^summaries-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    const diaryFiles = entries.filter((f) => /^diaries-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    const diaryDates = new Set(
      diaryFiles.map((f) => f.replace('diaries-', '').replace('.json', ''))
    );
    for (const sf of summaryFiles) {
      const dateStr = sf.replace('summaries-', '').replace('.json', '');
      if (diaryDates.has(dateStr)) continue;
      // 仅在“当天至少有一条 ok 汇总”时才需要生成日记，避免对空/全失败日做无用模型调用
      const sums = summary.loadDaySummaries(dataDir, dateStr);
      const hasOk = Object.keys(sums).some((b) => sums[b].status === 'ok');
      if (hasOk) missing.add(dateStr);
    }
  }
  return Array.from(missing).sort();
}

// 月历标记：返回 { 'DD': { hasSummary, hasDiary } }
function getMonthMarkers(dataDir, year, month) {
  const dir = path.join(dataDir, `${year}-${pad2(month)}`);
  const marks = {};
  if (!fs.existsSync(dir)) return marks;
  for (const f of fs.readdirSync(dir)) {
    let m = f.match(/^summaries-(\d{4}-\d{2}-(\d{2}))\.json$/);
    if (m) {
      marks[m[2]] = marks[m[2]] || {};
      marks[m[2]].hasSummary = true;
    }
    m = f.match(/^diaries-(\d{4}-\d{2}-(\d{2}))\.json$/);
    if (m) {
      marks[m[2]] = marks[m[2]] || {};
      marks[m[2]].hasDiary = true;
    }
  }
  return marks;
}

// 将一天所有 10 分钟汇总组装为喂给模型的紧凑上下文（按时间排序、截断防止过长）
function buildDiaryContext(sumsObj) {
  const buckets = Object.keys(sumsObj)
    .filter((b) => sumsObj[b].status === 'ok')
    .sort();
  const lines = [];
  for (const b of buckets) {
    const s = sumsObj[b];
    const bs = summary.bucketStart(b);
    const hh = pad2(bs.getHours());
    const mm = pad2(bs.getMinutes());
    const desc = (s.description || '').slice(0, 120);
    const sw = (s.software || []).join('、');
    lines.push(
      `[${hh}:${mm}] 项目：${s.project || '（未命名）'} | 分类：${s.category} | 软件：${sw} | ${desc}`
    );
  }
  let text = lines.join('\n');
  const MAX = 24000;
  if (text.length > MAX) {
    const head = text.slice(0, MAX * 0.7);
    const tail = text.slice(-(MAX * 0.3));
    text = head + '\n…（中间已省略）…\n' + tail;
  }
  return text;
}

// 括号平衡 JSON 提取器（与 summary.extractJsonObject 同策略，处理 ```json 围栏/夹带花括号）
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

function asStringArray(v, max) {
  let arr = Array.isArray(v) ? v : [];
  arr = arr
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);
  return arr;
}

function parseDiaryResponse(text) {
  if (!text || typeof text !== 'string') throw new Error('模型返回为空');
  const raw = extractJsonObject(text);
  if (!raw) throw new Error('模型返回中未找到 JSON');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error('模型返回的 JSON 解析失败：' + e.message);
  }
  return {
    brief: typeof obj.brief === 'string' ? obj.brief.trim() : '',
    mainItems: asStringArray(obj.mainItems, 3),
    highlights: asStringArray(obj.highlights, 8),
    todos: asStringArray(obj.todos, 30),
    suggestions: asStringArray(obj.suggestions, 10),
    tips: typeof obj.tips === 'string' ? obj.tips.trim() : '',
  };
}

async function generateDiary(cfg, date, sumsObj) {
  const dateStr = dayKey(new Date(date));
  const summariesText = buildDiaryContext(sumsObj) || '（当天无有效活动汇总）';
  const userPrompt = (cfg.diaryUserPrompt || '')
    .replace('{{DATE}}', dateStr)
    .replace('{{SUMMARIES}}', summariesText);

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: cfg.diarySystemPrompt || '' },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    format: 'json',
    options: buildModelOptions(cfg, 0.5),
  };

  const base = (cfg.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const res = await withModelGate(() =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.diaryTimeoutMs || 150000),
    })
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = (data && data.message && data.message.content) || '';
  const parsed = parseDiaryResponse(content);
  const okBuckets = Object.keys(sumsObj).filter((b) => sumsObj[b].status === 'ok').length;
  return {
    date: dateStr,
    brief: parsed.brief,
    mainItems: parsed.mainItems,
    highlights: parsed.highlights,
    todos: parsed.todos,
    suggestions: parsed.suggestions,
    tips: parsed.tips,
    status: 'ok',
    error: null,
    bucketCount: okBuckets,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  loadDayDiary,
  saveDiary,
  collectDiaryBacklog,
  getMonthMarkers,
  buildDiaryContext,
  parseDiaryResponse,
  generateDiary,
};

'use strict';

// 问答（agentic RAG over local activity records）
// 设计保持简单：不引入向量库，用“关键词命中”在三层数据源中检索。
// 三层源：
//   record  —— 每 20 秒一次的原始屏幕活动总结（5 句话）
//   summary —— 每 10 分钟一次的结构化汇总（project/category/description/software）
//   diary   —— 每日二阶日记（brief/mainItems/highlights/suggestions/tips）
// agentic 过程：最多 3 轮“规划(plan) → 检索(search)”，模型自行决定时间范围、
// 用哪种汇总、搜什么关键词；done=true 或轮数耗尽后，基于收集到的片段作答。

const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const { withModelGate, buildModelOptions } = require('./ollamaClient');

// 资源控制：单次查询时间跨度硬上限、单查询返回条数、回答上下文总字符上限
const MAX_SPAN_DAYS = 60;
const PER_QUERY_LIMIT = 40;
const CONTEXT_MAX_CHARS = 20000;
const MAX_ROUNDS = 3;

function pad2(n) {
  return String(n).padStart(2, '0');
}
function monthOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function dayKeyOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// 读取某天某源的全部条目（统一成 {_source,_ts,timestamp,project?,category?,software?,text}）
function readDaySource(dataDir, source, dateStr) {
  const dir = path.join(dataDir, monthOf(parseDate(dateStr)));
  if (!fs.existsSync(dir)) return [];

  if (source === 'record') {
    const entries = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(f) && f.startsWith(dateStr + '-'));
    const recs = [];
    for (const hf of entries) {
      const data = storage.readJson(path.join(dir, hf));
      if (data && Array.isArray(data.records)) {
        for (const r of data.records) {
          const text = [r.activity, (r.sentences || []).join(' ')].filter(Boolean).join(' ');
          recs.push({ _source: 'record', _ts: r.timestamp, timestamp: r.timestamp, text });
        }
      }
    }
    // 兜底：当月原始小时 JSON 已归档删除时，从 archive 读回文本（远期回看仍可命中）
    if (recs.length === 0) {
      const ar = storage.getArchiveRecords(dataDir, dateStr, dateStr);
      for (const e of ar) {
        const text = [e.activity, (e.sentences || []).join(' ')].filter(Boolean).join(' ');
        recs.push({ _source: 'record', _ts: e.timestamp, timestamp: e.timestamp, text, _archived: true });
      }
    }
    return recs;
  }

  if (source === 'summary') {
    const data = storage.readJson(path.join(dir, `summaries-${dateStr}.json`));
    if (!data || !data.summaries) return [];
    return Object.keys(data.summaries).map((b) => {
      const s = data.summaries[b];
      const text = [s.project, s.category, s.description, (s.software || []).join(' ')]
        .filter(Boolean)
        .join(' ');
      return {
        _source: 'summary',
        _ts: s.startTime || s.bucket,
        timestamp: s.startTime,
        project: s.project,
        category: s.category,
        software: s.software || [],
        text,
      };
    });
  }

  if (source === 'diary') {
    const data = storage.readJson(path.join(dir, `diaries-${dateStr}.json`));
    if (!data || data.status !== 'ok') return [];
    const text = [
      data.brief,
      (data.mainItems || []).join(' '),
      (data.highlights || []).join(' '),
      (data.suggestions || []).join(' '),
      data.tips,
    ]
      .filter(Boolean)
      .join(' ');
    return [
      {
        _source: 'diary',
        _ts: data.date,
        timestamp: data.date,
        project: null,
        category: null,
        software: [],
        text,
      },
    ];
  }
  return [];
}

// 执行一次检索：source + from + to + keywords → 命中片段（按时间倒序、命中数降序，限条数）
function searchSource(dataDir, source, from, to, keywords) {
  let start = parseDate(from);
  let end = parseDate(to);
  if (isNaN(start) || isNaN(end) || end < start) return [];

  // 硬上限跨度，超出则截断到“最近 MAX_SPAN_DAYS 天”，避免范围过大占资源
  const spanDays = Math.round((end - start) / 86400000);
  if (spanDays > MAX_SPAN_DAYS) {
    end = new Date(start);
    end.setDate(end.getDate() + MAX_SPAN_DAYS);
  }

  const kws = (keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  // 空关键词 = 拉取该时间范围内的全部内容（用于“我最近在干什么”等开放式回顾问题），
  // 不再像之前那样直接 return [] 导致开放式问题零命中。
  const allMatch = kws.length === 0;

  const hits = [];
  const cur = new Date(start);
  while (cur <= end) {
    const ds = dayKeyOf(cur);
    const items = readDaySource(dataDir, source, ds);
    for (const it of items) {
      const hay = (it.text || '').toLowerCase();
      let score = allMatch ? 1 : 0;
      if (!allMatch) {
        for (const k of kws) if (hay.includes(k)) score++;
      }
      if (score > 0) hits.push({ ...it, score });
    }
    cur.setDate(cur.getDate() + 1);
  }
  hits.sort((a, b) => (b._ts || '').localeCompare(a._ts || '') || b.score - a.score);
  return hits.slice(0, PER_QUERY_LIMIT);
}

// ---------- Ollama 调用（与 analyzer/diary 同模式）----------

async function ollamaChat(cfg, { system, user, json = false, timeout } = {}) {
  const base = (cfg.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system || '' },
      { role: 'user', content: user || '' },
    ],
    stream: false,
    options: buildModelOptions(cfg, 0.3),
  };
  if (json) body.format = 'json';
  const res = await withModelGate(() =>
    fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout || cfg.qaTimeoutMs || 120000),
    })
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data && data.message && data.message.content) || '';
}

// 括号平衡 JSON 提取（处理 ```json 围栏 / 夹带花括号）
function extractJson(text) {
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

// 解析规划结果：校验 source/日期，过滤非法项；无有效 query 视为 done
function parsePlan(text) {
  const raw = extractJson(text);
  if (!raw) return { queries: [], done: true };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { queries: [], done: true };
  }
  const list = Array.isArray(obj.queries) ? obj.queries : [];
  const queries = list
    .filter(
      (q) =>
        q &&
        ['record', 'summary', 'diary'].includes(q.source) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ''))
    )
    .map((q) => ({
      source: q.source,
      from: String(q.from),
      to: String(q.to),
      // 允许空 keywords：空数组表示“全量匹配”（开放式回顾用），不再强制至少 1 个关键词
      keywords: Array.isArray(q.keywords)
        ? q.keywords.slice(0, 6).map((k) => String(k).trim()).filter(Boolean)
        : [],
    }));
  return { queries, done: obj.done === true || queries.length === 0 };
}

// 把已收集片段压缩成摘要，喂给下一轮规划（避免重复检索、帮助模型判断是否需要补充）
function summarizeCollected(collected) {
  if (collected.length === 0) return '（尚未检索到任何片段）';
  const bySource = { record: 0, summary: 0, diary: 0 };
  const dates = new Set();
  for (const c of collected) {
    bySource[c._source] = (bySource[c._source] || 0) + 1;
    if (c.timestamp) dates.add(String(c.timestamp).slice(0, 10));
  }
  const top = collected
    .slice(0, 6)
    .map((c) => `[${c._source} ${String(c.timestamp || '').slice(0, 16)}] ${(c.text || '').slice(0, 120)}`)
    .join('\n');
  return (
    `已检索片段：${bySource.record} 条 record / ${bySource.summary} 条 summary / ` +
    `${bySource.diary} 条 diary；涉及日期：${[...dates].slice(0, 20).join(', ')}。\n` +
    `示例（前 6 条）：\n${top}`
  );
}

// 去重（同一 source + 时间戳 + 文本前缀视为重复）
function dedupe(collected) {
  const seen = new Set();
  const out = [];
  for (const c of collected) {
    const k = `${c._source}|${c.timestamp || ''}|${(c.text || '').slice(0, 50)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// 组装回答上下文（按时间倒序，截断防过大）
function buildAnswerContext(collected) {
  const sorted = [...collected].sort((a, b) => (b._ts || '').localeCompare(a._ts || ''));
  const parts = [];
  let total = 0;
  for (const c of sorted) {
    const meta =
      c._source === 'summary'
        ? `项目:${c.project || '-'} 分类:${c.category || '-'} 软件:${(c.software || []).join('/')}`
        : '';
    const line = `[${c._source} ${String(c.timestamp || '').slice(0, 16)}] ${meta}\n${(c.text || '').slice(0, 600)}`.trim();
    if (total + line.length > CONTEXT_MAX_CHARS) break;
    parts.push(line);
    total += line.length;
  }
  return parts.join('\n\n');
}

// 主流程：agentic 检索 + 回答
async function askQuestion(cfg, question) {
  const collected = [];
  const steps = [];
  const seenKeys = new Set();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const ctx =
      round === 1
        ? '（这是第一次检索，还没有任何片段，请直接给出检索查询）'
        : summarizeCollected(collected);
    const userPrompt = (cfg.qaPlanUserPrompt || '')
      .replace('{{QUESTION}}', question)
      .replace('{{CONTEXT}}', ctx);

    let planText;
    try {
      planText = await ollamaChat(cfg, {
        system: cfg.qaPlanSystemPrompt || '',
        user: userPrompt,
        json: true,
      });
    } catch (e) {
      steps.push({ round, error: e.message, queries: [], results: [] });
      break;
    }

    const plan = parsePlan(planText);
    let queries = plan.queries;
    let usedFallback = false;
    // 兜底：模型没给出任何有效查询（开放式问题常见），自动拉取最近 3 天的全部内容，
    // 保证“我最近在干什么”这类问题至少能拿到最近记录作答，而不是零检索就结束。
    if (queries.length === 0) {
      usedFallback = true;
      const to = dayKeyOf(new Date());
      const fromD = new Date();
      fromD.setDate(fromD.getDate() - 3);
      const from = dayKeyOf(fromD);
      queries = [
        { source: 'summary', from, to, keywords: [] },
        { source: 'record', from, to, keywords: [] },
        { source: 'diary', from, to, keywords: [] },
      ];
    }
    const results = [];
    const prevLen = collected.length;
    for (const q of queries) {
      const hits = searchSource(cfg.dataDir, q.source, q.from, q.to, q.keywords);
      for (const h of hits) {
        const k = `${h._source}|${h.timestamp || ''}|${(h.text || '').slice(0, 50)}`;
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          collected.push(h);
        }
      }
      results.push({
        source: q.source,
        from: q.from,
        to: q.to,
        keywords: q.keywords,
        count: hits.length,
      });
    }
    // 资源控制：若本轮未新增任何片段（重复/无效检索），提前停止，避免无意义多轮占用资源。
    // 注意：兜底轮（usedFallback）刚拉取了新内容，不应立即被 plan.done 提前终止。
    const noNew = collected.length - prevLen === 0;
    const stop = (!usedFallback && plan.done) || noNew;
    steps.push({ round, queries, results, done: stop, fallback: usedFallback });
    if (stop) break;
  }

  const deduped = dedupe(collected);
  let answer = '';
  try {
    const ctx = buildAnswerContext(deduped);
    const userPrompt = (cfg.qaAnswerUserPrompt || '')
      .replace('{{QUESTION}}', question)
      .replace('{{CONTEXT}}', ctx || '（未检索到相关片段）');
    answer = await ollamaChat(cfg, {
      system: cfg.qaAnswerSystemPrompt || '',
      user: userPrompt,
      json: false,
    });
  } catch (e) {
    answer = `回答生成失败：${e.message}`;
  }

  return { steps, collectedCount: deduped.length, answer };
}

module.exports = {
  askQuestion,
  searchSource,
  parsePlan,
  summarizeCollected,
  buildAnswerContext,
  dedupe,
};

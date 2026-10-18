'use strict';

/**
 * LifeLens 旧数据翻新脚本
 * ---------------------------------------------------------------------------
 * 背景：早期版本用 PowerShell 取窗口标题时编码错误，导致 activity 字段里的中文
 *       标题变成乱码（替换符 �）。本脚本只翻新“activity 含乱码且截图仍在、非隐私”的
 *       记录：用存储的截图重新跑本地视觉模型生成干净 activity，并重建受影响的 10 分钟汇总。
 *       原本干净的数据（含标题优先模式生成的“使用 Code：main.js”这类）一律不动。
 *
 * 用法（在 D:\LifeLens 目录下用 Node 22 运行）：
 *   node reanalyze.js --dry-run            # 只看会改什么，不写盘、不调模型
 *   node reanalyze.js --yes                # 真正执行（会先自动备份 data 目录）
 *   node reanalyze.js --yes --only activities   # 只重算 activity，不重建汇总
 *   node reanalyze.js --yes --only summaries    # 只重建汇总（假设 activity 已干净）
 *   node reanalyze.js --yes --limit 5      # 只处理前 5 条（调试用）
 *   node reanalyze.js --yes --bucket 2026-08-03-16-40   # 只重建指定 10 分钟桶（定点，秒级，不扫整天）
 *   node reanalyze.js --yes --data D:\other\data --settings D:\other\settings.json
 *
 * 前置：本机 Ollama 已启动且已拉取 cfg.model（默认 qwen3-vl:4b-instruct）。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const analyzer = require('./analyzer');
const summary = require('./summary');
const config = require('./config');

// ---------- 简易参数解析 ----------
const argv = process.argv.slice(2);
function hasFlag(f) { return argv.includes(f); }
function getOpt(f, def) {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

const DRY_RUN = hasFlag('--dry-run');
const DO_WRITE = hasFlag('--yes');
const ONLY = getOpt('--only', 'all'); // activities | summaries | all
const LIMIT = parseInt(getOpt('--limit', '0'), 10) || 0;
const BUCKET = getOpt('--bucket', ''); // 定点重建：只处理该 10 分钟桶（格式 YYYY-MM-DD-HH-MM）
const dataOverride = getOpt('--data', '');
const settingsOverride = getOpt('--settings', '');

// ---------- 加载配置（与 main.js 一致：DEFAULTS + settings.json）----------
function loadCfg() {
  let merged = { ...config.DEFAULTS };
  const candidates = [];
  if (settingsOverride) candidates.push(settingsOverride);
  candidates.push(path.join(__dirname, 'settings.json'));
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  candidates.push(path.join(appData, 'LifeLens', 'settings.json'));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const user = JSON.parse(fs.readFileSync(p, 'utf8'));
        merged = { ...merged, ...user };
        console.log(`[config] 已合并用户设置：${p}`);
        break;
      }
    } catch (_) { /* ignore */ }
  }
  if (!settingsOverride && !candidates.slice(1).some((p) => fs.existsSync(p))) {
    console.log('[config] 未发现 settings.json，使用内置默认值');
  }
  return merged;
}

const cfg = loadCfg();
const dataDir = dataOverride ? path.resolve(dataOverride) : cfg.dataDir;
if (!fs.existsSync(dataDir)) {
  console.error(`[fatal] dataDir 不存在：${dataDir}`);
  process.exit(1);
}

// ---------- 工具 ----------
const REPLACEMENT = '�';
function isGarbled(s) { return typeof s === 'string' && s.includes(REPLACEMENT); }

function pad2(n) { return String(n).padStart(2, '0'); }
function dayKeyOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function listHourFiles() {
  if (!fs.existsSync(dataDir)) return [];
  const out = [];
  for (const month of fs.readdirSync(dataDir)) {
    const dir = path.join(dataDir, month);
    if (!fs.statSync(dir).isDirectory() || !/^\d{4}-\d{2}$/.test(month)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(f)) out.push(path.join(dir, f));
    }
  }
  return out;
}

function listSummaryFiles() {
  if (!fs.existsSync(dataDir)) return [];
  const out = [];
  for (const month of fs.readdirSync(dataDir)) {
    const dir = path.join(dataDir, month);
    if (!fs.statSync(dir).isDirectory() || !/^\d{4}-\d{2}$/.test(month)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^summaries-\d{4}-\d{2}-\d{2}\.json$/.test(f)) out.push(path.join(dir, f));
    }
  }
  return out;
}

function listArchiveFiles() {
  const dir = path.join(dataDir, 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => path.join(dir, f));
}

// ---------- 主流程 ----------
async function main() {
  if (!DRY_RUN && !DO_WRITE) {
    console.log('⚠️  这是“写盘”操作。请先加 --dry-run 预览，确认无误后加 --yes 执行。');
    console.log('   例：node reanalyze.js --dry-run');
    console.log('   执行：node reanalyze.js --yes');
    return;
  }

  const hourFiles = listHourFiles();
  const summaryFiles = listSummaryFiles();
  const archiveFiles = listArchiveFiles();

  console.log(`\n数据目录：${dataDir}`);
  console.log(`小时记录文件：${hourFiles.length} 个 | 汇总文件：${summaryFiles.length} 个 | 归档文件：${archiveFiles.length} 个`);
  console.log(`模式：${DRY_RUN ? 'DRY-RUN（不写盘）' : 'REAL（将写盘，先备份）'}`);

  // 1) 扫描需要重算的记录
  let toFix = []; // {file, idx, record, bucketId, dayKey}
  let skippedNoImage = 0;
  let skippedPrivacy = 0;
  let unrecoverableArchive = 0;

  for (const hf of hourFiles) {
    const data = storage.readJson(hf);
    if (!data || !Array.isArray(data.records)) continue;
    for (let i = 0; i < data.records.length; i++) {
      const r = data.records[i];
      if (!isGarbled(r.activity)) continue;
      const b = summary.bucketId(new Date(r.timestamp));
      const dk = dayKeyOf(new Date(r.timestamp));
      if (r.privacy) { skippedPrivacy++; continue; }
      const imgOk = r.imagePath && fs.existsSync(r.imagePath);
      if (!imgOk) { skippedNoImage++; continue; }
      toFix.push({ file: hf, idx: i, record: r, bucketId: b, dayKey: dk });
    }
  }

  // 归档里含乱码但无截图 → 不可恢复，仅统计
  for (const af of archiveFiles) {
    const data = storage.readJson(af);
    if (!data || !Array.isArray(data.entries)) continue;
    for (const e of data.entries) if (isGarbled(e.activity)) unrecoverableArchive++;
  }

  console.log(`\n【待重算记录】${toFix.length} 条`);
  console.log(`【跳过】无截图 ${skippedNoImage} | 隐私 ${skippedPrivacy} | 归档不可恢复 ${unrecoverableArchive}`);

  if (BUCKET) {
    toFix = toFix.filter((t) => t.bucketId === BUCKET);
    console.log(`[--bucket] 仅处理桶 ${BUCKET}，命中 ${toFix.length} 条待重算记录`);
  }

  if (DRY_RUN) {
    console.log('\n--- DRY-RUN 预览（前 10 条）---');
    toFix.slice(0, 10).forEach((t) => {
      const before = (t.record.activity || '').slice(0, 50).replace(/\n/g, ' ');
      console.log(`  ${t.record.timestamp}  [${path.basename(t.file)}]  "${before}…"`);
    });
    if (toFix.length > 10) console.log(`  … 其余 ${toFix.length - 10} 条略`);
    console.log('\n（DRY-RUN 未做任何修改。加 --yes 执行真实翻新）');
    return;
  }

  // REAL：先校验 Ollama 可达
  console.log('\n[check] 校验 Ollama 可达性与模型…');
  const oc = await analyzer.checkOllama(cfg.ollamaBaseUrl, cfg.model);
  if (!oc.reachable) {
    console.error(`[fatal] 连不上 Ollama（${cfg.ollamaBaseUrl}）。请先启动 Ollama：`);
    console.error('        ollama serve   （或打开 Ollama 桌面应用）');
    process.exit(1);
  }
  if (!oc.modelInstalled) {
    console.error(`[fatal] Ollama 已连上，但未安装模型 "${cfg.model}"。请先拉取：`);
    console.error(`        ollama pull ${cfg.model}`);
    process.exit(1);
  }
  console.log(`[check] Ollama OK，模型 ${cfg.model} 可用`);

  // 备份
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = dataDir + `.backup-${stamp}`;
  console.log(`\n[backup] 备份 data → ${backupDir}`);
  fs.cpSync(dataDir, backupDir, { recursive: true });

  // 2) 重算 activity
  if (ONLY === 'all' || ONLY === 'activities') {
    const limit = LIMIT || toFix.length;
    let done = 0, failed = 0;
    // 按文件分组，减少重复读写
    const byFile = new Map();
    for (const t of toFix.slice(0, limit)) {
      if (!byFile.has(t.file)) byFile.set(t.file, []);
      byFile.get(t.file).push(t);
    }
    for (const [hf, items] of byFile) {
      const data = storage.readJson(hf);
      if (!data || !Array.isArray(data.records)) { failed += items.length; continue; }
      for (const t of items) {
        const r = data.records[t.idx];
        const imgBuf = fs.readFileSync(r.imagePath);
        const b64 = imgBuf.toString('base64');
        try {
          const text = await analyzer.analyzeImage(b64, cfg);
          r.activity = text.trim();
          r.sentences = storage.splitSentences(r.activity);
          r.analysisStatus = 'ok';
          r.error = null;
          r.model = cfg.model;
          r.reanalyzedAt = new Date().toISOString();
          done++;
          console.log(`  ✓ ${r.timestamp} → ${r.activity.slice(0, 40).replace(/\n/g, ' ')}…`);
        } catch (e) {
          r.analysisStatus = 'error';
          r.error = e.message;
          failed++;
          console.warn(`  ✗ ${r.timestamp} 分析失败：${e.message.slice(0, 80)}`);
        }
      }
      storage.writeJsonAtomic(hf, data);
    }
    console.log(`\n[activities] 重算完成：成功 ${done} | 失败 ${failed}`);
  } else {
    console.log('\n[activities] 跳过（--only summaries）');
  }

  // 3) 重建汇总
  if (ONLY === 'all' || ONLY === 'summaries') {
    if (BUCKET) {
      // ponytail: 定点模式——只重算一个桶，不扫整天（date 取桶 id 前 10 位，勿用 dayKeyOf 解析桶串）
      const dk = BUCKET.slice(0, 10);
      const sf = path.join(dataDir, dk.slice(0, 7), `summaries-${dk}.json`);
      const data = storage.readJson(sf);
      if (data && data.summaries && data.summaries[BUCKET]) {
        const records = summary.getRecordsInBucket(dataDir, BUCKET);
        const prev = data.summaries[BUCKET];
        try {
          const fresh = await summary.generateSummary(cfg, BUCKET, records, prev);
          summary.saveSummary(dataDir, fresh);
          console.log(`[summaries] 桶 ${BUCKET} 重建完成`);
        } catch (e) {
          console.warn(`  ✗ 桶 ${BUCKET} 汇总失败：${e.message.slice(0, 80)}`);
        }
      } else {
        console.log(`[summaries] 桶 ${BUCKET} 不存在于 ${sf}，跳过`);
      }
    } else {
      // 受影响的天：有重算记录的天，或汇总文件本身含乱码
      const affectedDays = new Set(toFix.map((t) => t.dayKey));
      for (const sf of summaryFiles) {
        const raw = fs.readFileSync(sf, 'utf8');
        if (isGarbled(raw)) {
          const dk = dayKeyOf(path.basename(sf).replace(/^summaries-/, '').replace(/\.json$/, ''));
          affectedDays.add(dk);
        }
      }
      console.log(`\n[summaries] 需重建的天：${Array.from(affectedDays).sort().join(', ') || '（无）'}`);
      let sumDone = 0, sumFail = 0;
      for (const dk of affectedDays) {
        const sf = path.join(dataDir, dk.slice(0, 7), `summaries-${dk}.json`);
        const data = storage.readJson(sf);
        if (!data || !data.summaries) continue;
        for (const b of Object.keys(data.summaries)) {
          const records = summary.getRecordsInBucket(dataDir, b);
          const prev = data.summaries[b];
          try {
            const fresh = await summary.generateSummary(cfg, b, records, prev);
            summary.saveSummary(dataDir, fresh);
            sumDone++;
            if (sumDone % 5 === 0) console.log(`  …已重建 ${sumDone} 个桶`);
          } catch (e) {
            sumFail++;
            console.warn(`  ✗ 桶 ${b} 汇总失败：${e.message.slice(0, 80)}`);
          }
        }
      }
      console.log(`[summaries] 重建完成：成功 ${sumDone} | 失败 ${sumFail}`);
    }
  } else {
    console.log('\n[summaries] 跳过（--only activities）');
  }

  console.log(`\n✅ 翻新完成。若结果不满意，备份在：${backupDir}`);
  console.log('   恢复：把 backup 目录改名回 data 即可（覆盖前先关闭 LifeLens）。');
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

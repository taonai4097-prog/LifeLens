'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 月份文件夹名：YYYY-MM
function monthFolderName(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

// 小时 JSON 文件名：YYYY-MM-DD-HH.json
function hourFileName(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}.json`
  );
}

// 截屏文件名：YYYY-MM-DD-HH-MM-SS.<ext>（默认 jpg）
function screenshotName(date, ext = 'jpg') {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}.${ext}`
  );
}

/**
 * 保存截屏图片，返回绝对路径。
 * 目录结构：<dataDir>/<YYYY-MM>/screenshots/<file>.<ext>
 */
function saveScreenshot(buffer, dataDir, date, ext = 'jpg') {
  const month = monthFolderName(date);
  const dir = path.join(dataDir, month, 'screenshots');
  ensureDir(dir);
  const name = screenshotName(date, ext);
  const full = path.join(dir, name);
  fs.writeFileSync(full, buffer);
  return full;
}

/**
 * 清理超过保留天数的旧截图文件（仅删 screenshots 目录下的图片，不碰 JSON 记录）。
 * 文本层（record/summary/diary）不依赖图片，删除旧截图不影响任何功能，
 * 仅损失“回看某时刻真实画面”。
 * @param {string} dataDir
 * @param {number} retentionDays 0 = 永久保留（不清理）
 * @returns {number} 删除的文件数
 */
function cleanupScreenshots(dataDir, retentionDays) {
  if (!retentionDays || retentionDays <= 0) return 0;
  if (!fs.existsSync(dataDir)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const month of fs.readdirSync(dataDir)) {
    const dir = path.join(dataDir, month, 'screenshots');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          deleted++;
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  return deleted;
}

/**
 * 统计 data 目录占用情况（用于 UI 显示与空间预警）。
 * @returns {{
 *   totalBytes:number, screenshotsBytes:number, recordsBytes:number,
 *   screenshotCount:number, hourlyRateBytes:number
 * }}
 * totalBytes      整个 data 目录字节数
 * screenshotsBytes 所有 screenshots 图片字节数
 * recordsBytes    所有 JSON（小时/汇总/日记）字节数
 * screenshotCount 截图文件数
 * hourlyRateBytes 最近 1 小时内新增截图的字节数（用于估算日增长率）
 */
function storageUsage(dataDir) {
  let totalBytes = 0;
  let screenshotsBytes = 0;
  let recordsBytes = 0;
  let screenshotCount = 0;
  let hourlyRateBytes = 0;
  const hourAgo = Date.now() - 60 * 60 * 1000;

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          walk(full);
        } else         if (e.isFile()) {
          const st = fs.statSync(full);
          totalBytes += st.size;
          // ponytail: 手动日记粘贴的照片放在 notes-images 下，不应计入“截图占用”与增长率，
          // 否则会污染空间预警；但计入 totalBytes（数据目录总占用）以保证真实。
          const inNotesImages = full.split(path.sep).includes('notes-images');
          if (!inNotesImages && /\.(png|jpe?g|webp)$/i.test(e.name)) {
            screenshotsBytes += st.size;
            screenshotCount++;
            if (st.mtimeMs >= hourAgo) hourlyRateBytes += st.size;
          } else if (/\.json$/i.test(e.name)) {
            recordsBytes += st.size;
          }
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  walk(dataDir);
  return { totalBytes, screenshotsBytes, recordsBytes, screenshotCount, hourlyRateBytes };
}

/**
 * 返回 data 目录所在磁盘的剩余可用字节（跨平台：mac/linux 用 statfs，windows 用 GetDiskFreeSpaceEx 等效）。
 * Node 22 提供 fs.statfsSync；若不可用则返回 null。
 */
function diskFreeBytes(dataDir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dataDir);
      // bavail * bsize = 非特权用户可用字节
      return s.bavail * s.bsize;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * 将一条记录追加进“当前小时”的 JSON 文件。
 * 文件结构：
 * {
 *   "date": "YYYY-MM-DD",
 *   "hour": 19,
 *   "records": [ { timestamp, imagePath, model, activity, sentences, analysisStatus, error }, ... ]
 * }
 * 采用“写临时文件再 rename”的原子方式，避免中途崩溃损坏 JSON。
 */
function appendRecord(dataDir, date, record) {
  const month = monthFolderName(date);
  const dir = path.join(dataDir, month);
  ensureDir(dir);
  const file = path.join(dir, hourFileName(date));

  let data = { date: isoDate(date), hour: date.getHours(), records: [] };
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed.records)) {
        data = { ...data, ...parsed, records: parsed.records };
      } else if (Array.isArray(parsed)) {
        // 兼容“纯数组”形态
        data.records = parsed;
      }
    } catch (e) {
      // 损坏则备份后重建
      const backup = file + '.corrupt.' + Date.now() + '.bak';
      try {
        fs.renameSync(file, backup);
      } catch (_) {
        /* ignore */
      }
      console.warn('[storage] 小时文件损坏，已备份重建：', backup);
    }
  }

  data.records.push(record);

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function isoDate(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  );
}

// 原子写入 JSON（先写临时文件再 rename，避免中途崩溃损坏）
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 安全读取 JSON：文件不存在返回 null；损坏则备份后返回 null
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const backup = file + '.corrupt.' + Date.now() + '.bak';
    try {
      fs.renameSync(file, backup);
    } catch (_) {
      /* ignore */
    }
    return null;
  }
}

// 读取某小时文件里的全部记录（records 数组）；文件不存在/损坏返回 []
function readHourRecords(dataDir, date) {
  const file = path.join(dataDir, monthFolderName(date), hourFileName(date));
  const data = readJson(file);
  if (!data) return [];
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data)) return data;
  return [];
}

// ===== 文本记录归档（着重设计）=====
// 三层存储：
//   LIVE   : data/<YYYY-MM>/<date>-<HH>.json —— 最近 N 天完整（文本+图片路径），可被汇总/问答/回看
//   ARCHIVE: data/archive/<YYYY-MM>.json     —— 超出 LIVE 窗口的整月，仅抽文本（timestamp/model/activity/sentences/privacy），
//                                             舍弃图片路径与原大 JSON，最大头空间释放；summary/diary 仍留 LIVE（看板/时间线依赖）
//   COLD   : archive 文件超过 maxArchiveAgeDays 直接删（默认 0=永久保留）
// ponytail: 朴素按月归档 + 守护“无汇总则不动”避免丢数据；不引入数据库/向量库。

function archiveDir(dataDir) {
  return path.join(dataDir, 'archive');
}

// 某月最后一天 23:59:59.999 的时间戳（用于判断整月是否超出 LIVE 窗口）
function monthEndMs(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  // new Date(y, m, 0) = 该月最后一天（m 为 1-based 月号）
  return new Date(y, m, 0, 23, 59, 59, 999).getTime();
}

/**
 * 归档：把超出 LIVE 窗口的整月小时 JSON 抽成文本归档，并删除原始小时文件。
 * @param {number} liveDays LIVE 窗口天数；<=0 表示不归档
 * @param {number} maxArchiveAgeDays 归档文件冷保留天数；>0 时超期删除
 * @returns {{archivedMonths:number, archivedEntries:number, deletedHourFiles:number, deletedArchives:number, errors:string[]}}
 */
function archiveOldRecords(dataDir, liveDays, maxArchiveAgeDays) {
  const result = {
    archivedMonths: 0,
    archivedEntries: 0,
    deletedHourFiles: 0,
    deletedArchives: 0,
    errors: [],
  };
  if (!liveDays || liveDays <= 0) return result; // 关
  if (!fs.existsSync(dataDir)) return result;

  const cutoff = Date.now() - liveDays * 24 * 60 * 60 * 1000;
  const monthDirs = fs
    .readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}$/.test(f))
    .map((f) => ({ key: f, dir: path.join(dataDir, f) }))
    .filter((m) => fs.statSync(m.dir).isDirectory());

  for (const { key, dir } of monthDirs) {
    if (monthEndMs(key) >= cutoff) continue; // 仍在 LIVE 窗口，跳过
    try {
      const entries = fs.readdirSync(dir);
      const hourFiles = entries.filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(f));
      const hasSummary = entries.some((f) => /^summaries-\d{4}-\d{2}-\d{2}\.json$/.test(f));
      if (hourFiles.length === 0) continue; // 无原始记录可归档
      // 守护：该月有原始记录却没有任何汇总 → 留 LIVE，等汇总跑完再归档，避免丢数据
      if (!hasSummary) {
        result.errors.push(`跳过 ${key}：存在原始记录但无汇总，暂不归档`);
        continue;
      }
      const out = [];
      for (const hf of hourFiles) {
        const data = readJson(path.join(dir, hf));
        const recs = data && Array.isArray(data.records) ? data.records : [];
        for (const r of recs) {
          out.push({
            timestamp: r.timestamp,
            model: r.model,
            activity: r.activity,
            sentences: r.sentences,
            privacy: r.privacy || null,
          });
        }
      }
      out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      if (out.length === 0) {
        // 有文件但无记录（理论上不会），仍清理空文件
        hourFiles.forEach((hf) => safeUnlink(path.join(dir, hf)));
        result.deletedHourFiles += hourFiles.length;
        continue;
      }
      const archiveFile = path.join(archiveDir(dataDir), `${key}.json`);
      ensureDir(archiveDir(dataDir));
      writeJsonAtomic(archiveFile, {
        month: key,
        archivedAt: new Date().toISOString(),
        count: out.length,
        entries: out,
      });
      // 归档成功后删除原始小时文件（释放最大头空间）
      for (const hf of hourFiles) {
        if (safeUnlink(path.join(dir, hf))) result.deletedHourFiles++;
      }
      result.archivedMonths++;
      result.archivedEntries += out.length;
    } catch (e) {
      result.errors.push(`${key}: ${e.message}`);
    }
  }

  // COLD: 超期归档文件删除
  if (maxArchiveAgeDays && maxArchiveAgeDays > 0) {
    const aDir = archiveDir(dataDir);
    if (fs.existsSync(aDir)) {
      const archiveCutoff = Date.now() - maxArchiveAgeDays * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(aDir)) {
        if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
        if (monthEndMs(f.replace('.json', '')) < archiveCutoff) {
          if (safeUnlink(path.join(aDir, f))) result.deletedArchives++;
        }
      }
    }
  }
  return result;
}

function safeUnlink(full) {
  try {
    fs.unlinkSync(full);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 读取归档中落在 [from, to] 区间的条目（用于远期回看 / 导出 / QA 兜底）。
 * @param {Date|string} from
 * @param {Date|string} to
 * @returns {Array<{timestamp,model,activity,sentences,privacy,month}>}
 */
function getArchiveRecords(dataDir, from, to) {
  const aDir = archiveDir(dataDir);
  if (!fs.existsSync(aDir)) return [];
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const out = [];
  for (const f of fs.readdirSync(aDir)) {
    if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
    const data = readJson(path.join(aDir, f));
    if (!data || !Array.isArray(data.entries)) continue;
    for (const e of data.entries) {
      const t = new Date(e.timestamp).getTime();
      if (t >= fromMs && t <= toMs) out.push({ ...e, month: data.month });
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // 倒序（新→旧）
  return out;
}

// 归档统计（供 UI / 存储预警展示）
function archiveInfo(dataDir) {
  const aDir = archiveDir(dataDir);
  if (!fs.existsSync(aDir)) return { archiveCount: 0, archiveBytes: 0, months: [] };
  let archiveBytes = 0;
  const months = [];
  for (const f of fs.readdirSync(aDir)) {
    if (!/^\d{4}-\d{2}\.json$/.test(f)) continue;
    try {
      const st = fs.statSync(path.join(aDir, f));
      archiveBytes += st.size;
      months.push({ month: f.replace('.json', ''), bytes: st.size });
    } catch (_) {
      /* ignore */
    }
  }
  return { archiveCount: months.length, archiveBytes, months };
}

/**
 * 将模型返回的文本切分为句子（最多 5 句）。
 * 以中文/英文句号、感叹号、问号、换行作为断句符。
 */
function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  const parts = text
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(0, 5);
}

module.exports = {
  ensureDir,
  monthFolderName,
  hourFileName,
  screenshotName,
  saveScreenshot,
  cleanupScreenshots,
  storageUsage,
  diskFreeBytes,
  appendRecord,
  splitSentences,
  writeJsonAtomic,
  readJson,
  readHourRecords,
  archiveOldRecords,
  getArchiveRecords,
  archiveInfo,
};

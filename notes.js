'use strict';

// 手动日记（随笔/随手记）模块：类似微信收藏夹，用户自行编写当日做了什么、反思、待解决，
// 支持粘贴/拖入照片、# 标签分类。与 AI 自动生成的“回顾”相互独立：
//   - AI 回顾：data/<YYYY-MM>/diaries-YYYY-MM-DD.json（由截图汇总生成，只读展示）
//   - 手动日记：data/<YYYY-MM>/notes-YYYY-MM-DD.json（用户编写，可编辑）
//   - 照片：data/notes-images/<YYYY-MM-DD>/<random>.<ext>（按日期归集，便于孤儿清理）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

function pad2(n) {
  return String(n).padStart(2, '0');
}
function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

// 某天笔记文件：data/<YYYY-MM>/notes-YYYY-MM-DD.json
function noteDayFile(dataDir, date) {
  const d = new Date(date);
  return path.join(
    dataDir,
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
    `notes-${dayKey(d)}.json`
  );
}

// 某天笔记图片目录：data/notes-images/<YYYY-MM-DD>/
function noteImagesDir(dataDir, date) {
  return path.join(dataDir, 'notes-images', dayKey(date));
}

function loadDayNote(dataDir, date) {
  const data = storage.readJson(noteDayFile(dataDir, date));
  if (!data) return null;
  return data;
}

function saveDayNote(dataDir, note) {
  const file = noteDayFile(dataDir, note.date);
  storage.ensureDir(path.dirname(file));
  storage.writeJsonAtomic(file, note);
  return file;
}

function deleteDayNote(dataDir, date) {
  const file = noteDayFile(dataDir, date);
  let removed = false;
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
    }
  } catch (_) {
    /* ignore */
  }
  // 同时清掉该日图片目录
  try {
    const imgDir = noteImagesDir(dataDir, date);
    if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  return removed;
}

// 保存一张粘贴/拖入的图片，返回 { rel, url }
// buf: Node Buffer（由渲染进程以字节数组传入后重构）
function saveNoteImage(dataDir, date, ext, buf) {
  const dir = noteImagesDir(dataDir, date);
  storage.ensureDir(dir);
  const cleanExt = String(ext || 'png')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase() || 'png';
  const name = `${crypto.randomBytes(8).toString('hex')}.${cleanExt}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buf);
  const rel = path.relative(dataDir, full).split(path.sep).join('/');
  // file:// 必须用正斜杠
  const url = 'file://' + full.split(path.sep).join('/');
  return { rel, url };
}

// 月历标记：扫描 notes-*.json，返回 { 'DD': { hasNote:true } }
function getMonthNoteMarkers(dataDir, year, month) {
  const dir = path.join(dataDir, `${year}-${pad2(month)}`);
  const marks = {};
  if (!fs.existsSync(dir)) return marks;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^notes-(\d{4}-\d{2}-(\d{2}))\.json$/);
    if (m) {
      const dd = m[2];
      marks[dd] = marks[dd] || {};
      marks[dd].hasNote = true;
    }
  }
  return marks;
}

// 从纯文本提取标签，支持两种写法：
//   - #标签#          （闭合 #，可含空格，例如 #待解决 明天继续#）
//   - #标签           （无闭合，遇空白/换行/# 即止，适合英文或空格分隔）
// 例如：「今天 #反思# 做了评审 #待解决 明天继续 #工作」
//   → ['反思', '待解决', '工作']（中间的“明天继续”为自由文本，不是标签）
function extractTags(text) {
  if (!text || typeof text !== 'string') return [];
  const tags = new Set();
  const re = /#([^#\s\n]+)#|#([^\s#\n]+)/g;
  let m;
  while ((m = re.exec(text))) {
    let t = (m[1] != null ? m[1] : m[2]).trim();
    // 去掉结尾的中英文标点
    t = t.replace(/[，。、！？!?；;：:，,.]+$/, '').trim();
    if (t) tags.add(t);
  }
  return Array.from(tags);
}

// 列出全部标签：[{ tag, count, dates:[] }]（count 为出现天数，dates 去重）
function getAllTags(dataDir) {
  const result = {};
  if (!fs.existsSync(dataDir)) return [];
  for (const month of fs.readdirSync(dataDir)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const dir = path.join(dataDir, month);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^notes-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const note = storage.readJson(path.join(dir, f));
      if (!note || !Array.isArray(note.tags) || !note.tags.length) continue;
      for (const tag of note.tags) {
        if (!result[tag]) result[tag] = { tag, count: 0, dates: [] };
        result[tag].count++;
        if (!result[tag].dates.includes(note.date)) result[tag].dates.push(note.date);
      }
    }
  }
  return Object.values(result).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}

// 从 HTML 中抽取“仍被引用”的笔记图片相对路径（用于孤儿清理）
// 仅识别 dataDir/notes-images/ 下的图片，返回相对 dataDir 的 posix 路径。
function referencedImages(dataDir, html) {
  if (!html || typeof html !== 'string') return [];
  const dataPrefix = 'file://' + dataDir.split(path.sep).join('/');
  const marker = '/notes-images/';
  const out = [];
  const re = /file:\/\/([^\s"'<>]+)/g;
  let match;
  while ((match = re.exec(html))) {
    const decoded = decodeURIComponent(match[1]).split('\\').join('/');
    const idx = decoded.indexOf(marker);
    if (idx >= 0) {
      // 从 notes-images 起算相对路径
      out.push(decoded.slice(idx + marker.length - 1).replace(/^\//, ''));
    } else if (decoded.startsWith(dataPrefix)) {
      // 兜底：直接在 dataDir 下的笔记图片
      out.push(decoded.slice(dataPrefix.length).replace(/^\//, ''));
    }
  }
  return out;
}

module.exports = {
  loadDayNote,
  saveDayNote,
  deleteDayNote,
  saveNoteImage,
  getMonthNoteMarkers,
  extractTags,
  getAllTags,
  referencedImages,
};

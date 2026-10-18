'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  sumBadge: $('sumBadge'),
  sumQueue: $('sumQueue'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnCheck: $('btnCheck'),
  shotImg: $('shotImg'),
  shotPlaceholder: $('shotPlaceholder'),
  shotMeta: $('shotMeta'),
  activityList: $('activityList'),
  logBox: $('logBox'),
  settingsForm: $('settingsForm'),
  saveHint: $('saveHint'),
  fInterval: $('fInterval'),
  fQuality: $('fQuality'),
  fMaxWidth: $('fMaxWidth'),
  fRetention: $('fRetention'),
  fRepOnly: $('fRepOnly'),
  fBaseUrl: $('fBaseUrl'),
  fModel: $('fModel'),
  fDataDir: $('fDataDir'),
  fSystem: $('fSystem'),
  fPrompt: $('fPrompt'),
  // 存储与空间
  siTotal: $('siTotal'),
  siShots: $('siShots'),
  siRecs: $('siRecs'),
  siHourly: $('siHourly'),
  siDaily: $('siDaily'),
  siFree: $('siFree'),
  siRetention: $('siRetention'),
  siDaysLeft: $('siDaysLeft'),
  siStatus: $('siStatus'),
  // 动态页
  tabMonitor: $('tab-monitor'),
  tabDynamic: $('tab-dynamic'),
  heatRange: $('heatRange'),
  heatmap: $('heatmap'),
  heatDetail: $('heatDetail'),
  btnRefresh: $('btnRefresh'),
  fProject: $('fProject'),
  fSoftware: $('fSoftware'),
  fDay: $('fDay'),
  btnClearFilter: $('btnClearFilter'),
  timeline: $('timeline'),
  tlMore: $('tlMore'),
  // 日记页
  tabDiary: $('tab-diary'),
  tabDashboard: $('tab-dashboard'),
  diaryStatus: $('diaryStatus'),
  calPrev: $('calPrev'),
  calNext: $('calNext'),
  calToday: $('calToday'),
  calTitle: $('calTitle'),
  calGrid: $('calGrid'),
  diarySelected: $('diarySelected'),
  diaryContent: $('diaryContent'),
  diaryRegen: $('diaryRegen'),
  // 手动日记页
  tabNotes: $('tab-notes'),
  noteStatus: $('noteStatus'),
  notesCalPrev: $('notesCalPrev'),
  notesCalNext: $('notesCalNext'),
  notesCalToday: $('notesCalToday'),
  notesCalTitle: $('notesCalTitle'),
  notesCalGrid: $('notesCalGrid'),
  noteTagCloud: $('noteTagCloud'),
  noteSelected: $('noteSelected'),
  noteEditor: $('noteEditor'),
  noteTags: $('noteTags'),
  noteTagsHint: $('noteTagsHint'),
  noteSave: $('noteSave'),
  noteClear: $('noteClear'),
  noteSaveHint: $('noteSaveHint'),
  noteTagResults: $('noteTagResults'),
  // 看板页
  dashType: $('dashType'),
  dashDate: $('dashDate'),
  dashRefresh: $('dashRefresh'),
  statCards: $('statCards'),
  // 问答页
  tabQa: $('tab-qa'),
  qaInput: $('qaInput'),
  qaAsk: $('qaAsk'),
  qaStatus: $('qaStatus'),
  qaSteps: $('qaSteps'),
  qaAnswer: $('qaAnswer'),
};

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function catColor(cat) {
  return (
    { 娱乐: '#f59e0b', 工作: '#2f6df6', 学习: '#2bb673', 社交: '#a855f7' }[cat] ||
    '#9aa3b2'
  );
}

function fmtBucketRange(bucketId) {
  const m = bucketId.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return bucketId;
  const [, , M, D, H, Min] = m;
  const endMin = (parseInt(Min, 10) + 10) % 60;
  return `${M}-${D} ${H}:${Min}–${String(endMin).padStart(2, '0')}`;
}

// ---------- 日志 ----------
function log(level, msg) {
  const line = document.createElement('div');
  line.className = 'line';
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.innerHTML = `<span class="time">${t}</span><span class="${level}">${escapeHtml(msg)}</span>`;
  els.logBox.appendChild(line);
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

// ---------- 监控页 ----------
function setRunning(running) {
  els.statusDot.classList.toggle('running', !!running);
  els.statusText.textContent = running ? '截屏中' : '已停止';
  els.statusText.classList.toggle('running', !!running);
  els.btnStart.disabled = !!running;
  els.btnStop.disabled = !running;
  log('info', running ? '状态：运行中' : '状态：已停止');
}

function renderActivity(record) {
  els.activityList.innerHTML = '';
  if (record.analysisStatus === 'error') {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '本次分析失败：' + (record.error || '未知错误');
    els.activityList.appendChild(li);
    return;
  }
  const sentences =
    record.sentences && record.sentences.length
      ? record.sentences
      : [record.activity || '（无内容）'];
  sentences.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    els.activityList.appendChild(li);
  });
}

function renderScreenshot(payload) {
  els.shotImg.src = 'file://' + payload.imagePath;
  els.shotImg.classList.add('show');
  els.shotPlaceholder.style.display = 'none';
  const d = new Date(payload.timestamp);
  els.shotMeta.textContent = `时间：${d.toLocaleString('zh-CN', { hour12: false })}  路径：${payload.imagePath}`;
}

async function loadConfigToForm() {
  const cfg = await window.api.getConfig();
  els.fInterval.value = cfg.captureIntervalMs / 1000;
  els.fQuality.value = cfg.screenshotQuality;
  els.fMaxWidth.value = cfg.screenshotMaxWidth;
  els.fRetention.value = cfg.screenshotRetentionDays;
  els.fRepOnly.checked = !!cfg.keepRepresentativeOnly;
  els.fBaseUrl.value = cfg.ollamaBaseUrl;
  els.fModel.value = cfg.model;
  els.fDataDir.value = cfg.dataDir;
  els.fSystem.value = cfg.systemPrompt;
  els.fPrompt.value = cfg.prompt;
}

els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const partial = {
    captureIntervalMs: Math.max(5, parseInt(els.fInterval.value, 10) || 20) * 1000,
    screenshotQuality: Math.min(100, Math.max(10, parseInt(els.fQuality.value, 10) || 70)),
    screenshotMaxWidth: Math.max(0, parseInt(els.fMaxWidth.value, 10) || 0),
    screenshotRetentionDays: Math.max(0, parseInt(els.fRetention.value, 10) || 0),
    keepRepresentativeOnly: !!els.fRepOnly.checked,
    ollamaBaseUrl: els.fBaseUrl.value.trim(),
    model: els.fModel.value.trim(),
    dataDir: els.fDataDir.value.trim(),
    systemPrompt: els.fSystem.value,
    prompt: els.fPrompt.value,
  };
  await window.api.updateConfig(partial);
  els.saveHint.textContent = '已保存 ✓';
  setTimeout(() => (els.saveHint.textContent = ''), 2500);
  log('info', '设置已保存');
  refreshStorageInfo();
});

// ---------- 存储与空间 ----------
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function refreshStorageInfo() {
  let info;
  try {
    info = await window.api.getStorageInfo();
  } catch (_) {
    return;
  }
  if (!info) return;
  els.siTotal.textContent = fmtBytes(info.totalBytes);
  els.siShots.textContent = `${fmtBytes(info.screenshotsBytes)}（${info.screenshotCount} 张）`;
  els.siRecs.textContent = fmtBytes(info.recordsBytes);
  els.siHourly.textContent = fmtBytes(info.hourlyRateBytes);
  els.siDaily.textContent = fmtBytes(info.dailyProjectedBytes);
  els.siFree.textContent = fmtBytes(info.freeBytes);
  els.siRetention.textContent =
    (info.retentionDays > 0 ? `保留 ${info.retentionDays} 天` : '永久保留') +
    (info.keepRepresentativeOnly ? ' · 仅代表帧' : ' · 全量');
  if (info.daysLeft != null) {
    els.siDaysLeft.textContent = `约 ${Math.floor(info.daysLeft)} 天爆满`;
  } else {
    els.siDaysLeft.textContent = '—';
  }
  if (info.status === 'warn') {
    els.siStatus.textContent = '⚠ 剩余空间可能不足：建议降低“旧截图保留天数”或关闭“仅代表帧”。';
    els.siStatus.className = 'si-status warn';
  } else {
    els.siStatus.textContent =
      info.retentionDays > 0
        ? '✓ 受保留策略约束，截图占用不会无限增长。'
        : '（未开启保留：截图会一直累积，建议设置保留天数）';
    els.siStatus.className = 'si-status safe';
  }
}

// ---------- 汇总状态徽标 ----------
function setSummaryStatus(p) {
  const active = p.summarizing || p.queueLength > 0;
  els.sumBadge.hidden = !active;
  els.sumQueue.textContent = p.queueLength > 0 ? `（队列 ${p.queueLength}）` : '';
}

// ---------- 标签页 ----------
const TAB_PANELS = {
  monitor: () => els.tabMonitor,
  dynamic: () => els.tabDynamic,
  notes: () => els.tabNotes,
  diary: () => els.tabDiary,
  dashboard: () => els.tabDashboard,
  qa: () => els.tabQa,
};

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  Object.keys(TAB_PANELS).forEach((n) => {
    const el = TAB_PANELS[n]();
    if (el) el.classList.toggle('hidden', name !== n);
  });
  if (name === 'dynamic') initDynamic();
  if (name === 'notes') initNotes();
  if (name === 'diary') initDiary();
  if (name === 'dashboard') initDashboard();
  if (name === 'qa') initQa();
}

function dayKeyLocal(d) {
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`
  );
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKeyLocal(d);
}

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ---------- 动态页：热力图 ----------
let dynamicInited = false;

async function renderHeatmap() {
  const hours = parseInt(els.heatRange.value, 10) || 24;
  const cells = await window.api.getHeatmap({ hours });
  els.heatmap.innerHTML = '';
  cells.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'heat-cell' + (c.status !== 'empty' ? ' has-data' : '');
    if (c.status === 'done') {
      div.style.background = catColor(c.category);
      div.title = `${fmtBucketRange(c.bucket)} · ${c.category} · ${c.recordCount} 次截屏`;
    } else if (c.status === 'pending') {
      div.classList.add('st-pending');
      div.title = `${fmtBucketRange(c.bucket)} · 待汇总 · ${c.recordCount} 次截屏`;
    } else {
      div.title = `${fmtBucketRange(c.bucket)} · 无数据`;
    }
    if (c.status !== 'empty') {
      div.addEventListener('click', () => showBucketDetail(c.bucket, c));
    }
    els.heatmap.appendChild(div);
  });
}

async function showBucketDetail(bucketId, cellInfo) {
  const { summary, records } = await window.api.getBucketDetail(bucketId);
  if (summary && summary.status === 'ok') {
    const sw = `<span class="sw cat-${summary.category}" style="background:${catColor(
      summary.category
    )}"></span>`;
    let html = `${fmtBucketRange(bucketId)}　${sw} <b>${escapeHtml(
      summary.project || '（未命名）'
    )}</b> [${summary.category}]\n`;
    html += summary.description || '（无描述）';
    if (summary.software && summary.software.length) {
      html += `\n\n软件：${summary.software.map((s) => escapeHtml(s)).join('、')}`;
    }
    if (summary.todos && summary.todos.length) {
      html += `\n可能遗漏的待办：${summary.todos.map((s) => escapeHtml(s)).join('；')}`;
    }
    els.heatDetail.classList.remove('muted');
    els.heatDetail.textContent = html;
  } else if (summary && summary.status === 'error') {
    els.heatDetail.classList.remove('muted');
    els.heatDetail.textContent = `${fmtBucketRange(bucketId)} 汇总失败：${summary.error || ''}`;
  } else {
    // pending：展示该窗口已有记录的活动总结
    const acts = (records || [])
      .map((r) => r.activity)
      .filter(Boolean)
      .join('\n');
    els.heatDetail.classList.remove('muted');
    els.heatDetail.textContent = `${fmtBucketRange(bucketId)} 尚未汇总（共 ${
      (records || []).length
    } 次截屏）。\n${acts || '（无记录）'}`;
  }
}

// ---------- 动态页：时间线 + 筛选 ----------
const tlState = { offset: 0, limit: 50, loading: false, hasMore: false, items: [] };

function tlFilters() {
  const day = els.fDay.value; // YYYY-MM-DD 或空
  let from = null;
  let to = null;
  if (day) {
    from = `${day}T00:00:00`;
    to = `${day}T23:59:59`;
  }
  return {
    project: els.fProject.value.trim() || null,
    software: els.fSoftware.value || null,
    from,
    to,
    limit: tlState.limit,
    offset: tlState.offset,
    sort: 'desc',
  };
}

async function loadTimeline(reset) {
  if (tlState.loading) return;
  if (reset) {
    tlState.offset = 0;
    tlState.items = [];
    els.timeline.innerHTML = '';
  }
  tlState.loading = true;
  try {
    const res = await window.api.getTimeline(tlFilters());
    tlState.hasMore = res.hasMore;
    if (res.items.length === 0 && tlState.offset === 0) {
      els.timeline.innerHTML = '<div class="tl-empty">暂无汇总数据。运行一段时间后这里会显示你的活动。</div>';
    } else {
      res.items.forEach((s) => els.timeline.appendChild(renderTimelineItem(s)));
    }
    tlState.offset += res.items.length;
    els.tlMore.textContent = tlState.hasMore ? '下拉加载更多…' : '没有更多了';
  } catch (e) {
    log('error', '时间线加载失败：' + e.message);
  } finally {
    tlState.loading = false;
  }
}

function renderTimelineItem(s) {
  const item = document.createElement('div');
  item.className = 'tl-item';

  const top = document.createElement('div');
  top.className = 'tl-top';
  top.innerHTML =
    `<span class="tl-time">${fmtBucketRange(s.bucket)}</span>` +
    `<span class="tl-project">${escapeHtml(s.project || '（未命名）')}</span>` +
    `<span class="cat-badge" style="background:${catColor(s.category)}">${s.category}</span>`;
  item.appendChild(top);

  const desc = document.createElement('div');
  desc.className = 'tl-desc';
  desc.textContent = s.description || '（无描述）';
  item.appendChild(desc);

  if ((s.description || '').length > 80) {
    const toggle = document.createElement('span');
    toggle.className = 'tl-toggle';
    toggle.textContent = '展开/收起';
    toggle.addEventListener('click', () => desc.classList.toggle('expanded'));
    item.appendChild(toggle);
  }

  if (s.software && s.software.length) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    s.software.forEach((sw) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = sw;
      tag.title = '按此软件筛选';
      tag.addEventListener('click', () => {
        els.fSoftware.value = sw;
        loadTimeline(true);
      });
      tags.appendChild(tag);
    });
    item.appendChild(tags);
  }
  return item;
}

function onTimelineScroll() {
  const el = els.timeline;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
    if (tlState.hasMore && !tlState.loading) loadTimeline(false);
  }
}

async function refreshFilterOptions() {
  const opts = await window.api.getFilterOptions({});
  const cur = els.fSoftware.value;
  els.fSoftware.innerHTML = '<option value="">全部软件</option>';
  opts.software.forEach((sw) => {
    const o = document.createElement('option');
    o.value = sw;
    o.textContent = sw;
    els.fSoftware.appendChild(o);
  });
  if (cur) els.fSoftware.value = cur;
}

async function initDynamic() {
  if (!dynamicInited) {
    await refreshFilterOptions();
    els.timeline.addEventListener('scroll', onTimelineScroll);
    dynamicInited = true;
  }
  await renderHeatmap();
  await loadTimeline(true);
}

// 事件
els.heatRange.addEventListener('change', renderHeatmap);
els.btnRefresh.addEventListener('click', async () => {
  await renderHeatmap();
  await loadTimeline(true);
  await refreshFilterOptions();
});
els.fProject.addEventListener('input', debounce(() => loadTimeline(true), 400));
els.fSoftware.addEventListener('change', () => loadTimeline(true));
els.fDay.addEventListener('change', () => loadTimeline(true));
els.btnClearFilter.addEventListener('click', () => {
  els.fProject.value = '';
  els.fSoftware.value = '';
  els.fDay.value = '';
  loadTimeline(true);
});

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------- 日记页：日历 + 日记 ----------
const calState = { year: 0, month: 0, selected: null };
let diaryInited = false;

async function renderCalendar() {
  const y = calState.year;
  const m = calState.month;
  els.calTitle.textContent = `${y}年${m}月`;
  let markers = {};
  try {
    markers = await window.api.getMonthMarkers(y, m);
  } catch (e) {
    /* ignore */
  }
  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay(); // 0=周日
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  els.calGrid.innerHTML = '';
  cells.forEach((d) => {
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (d === null) {
      cell.classList.add('other');
      els.calGrid.appendChild(cell);
      return;
    }
    cell.classList.add('in-month');
    const dd = String(d).padStart(2, '0');
    const mk = markers[dd];
    if (mk && mk.hasSummary) cell.classList.add('has-sum');
    if (mk && mk.hasDiary) cell.classList.add('has-diary');
    cell.textContent = d;
    const full = `${y}-${String(m).padStart(2, '0')}-${dd}`;
    if (full === calState.selected) cell.classList.add('selected');
    cell.addEventListener('click', () => selectDay(full));
    els.calGrid.appendChild(cell);
  });
}

async function selectDay(full) {
  calState.selected = full;
  els.diarySelected.textContent = `所选日期：${full}`;
  els.diaryContent.innerHTML = '<div class="pending">加载中…</div>';
  els.diaryRegen.hidden = true;
  await renderCalendar();
  await loadDiary(full);
}

async function loadDiary(full) {
  let res;
  try {
    res = await window.api.getDiary(full);
  } catch (e) {
    els.diaryContent.innerHTML = `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  if (res.status === 'ok') {
    renderDiary(res.diary);
  } else if (res.status === 'pending') {
    els.diaryContent.innerHTML =
      '<div class="pending">日记生成中…（首次生成本地模型需稍候，完成后自动刷新）</div>';
    els.diaryRegen.hidden = true;
  } else {
    els.diaryContent.innerHTML =
      '<div class="empty">当天没有截屏记录，无法生成日记。</div>';
    els.diaryRegen.hidden = true;
  }
}

function renderDiary(d) {
  els.diaryRegen.hidden = false;
  const section = (title, html) =>
    `<div class="d-section"><h3>${title}</h3>${html}</div>`;
  const list = (arr) =>
    arr && arr.length
      ? `<ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
      : '<div class="muted">—</div>';
  const brief = d.brief
    ? `<div class="brief">${escapeHtml(d.brief)}</div>`
    : '<div class="muted">—</div>';
  const tips = d.tips ? escapeHtml(d.tips) : '—';

  els.diaryContent.innerHTML =
    section('简短总结', brief) +
    section('主要事项（三件）', list(d.mainItems)) +
    section('高光时刻', list(d.highlights)) +
    section('待办', list(d.todos)) +
    section('优化建议', list(d.suggestions)) +
    section('温馨提示', `<div class="brief">${tips}</div>`);
}

async function initDiary() {
  if (!diaryInited) {
    const n = new Date();
    calState.year = n.getFullYear();
    calState.month = n.getMonth() + 1;
    calState.selected = yesterdayStr();
    els.calPrev.addEventListener('click', () => {
      calState.month--;
      if (calState.month < 1) {
        calState.month = 12;
        calState.year--;
      }
      renderCalendar();
    });
    els.calNext.addEventListener('click', () => {
      calState.month++;
      if (calState.month > 12) {
        calState.month = 1;
        calState.year++;
      }
      renderCalendar();
    });
    els.calToday.addEventListener('click', () => {
      const t = new Date();
      calState.year = t.getFullYear();
      calState.month = t.getMonth() + 1;
      calState.selected = yesterdayStr();
      renderCalendar();
      loadDiary(calState.selected);
    });
    els.diaryRegen.addEventListener('click', async () => {
      await window.api.requestDiary(calState.selected);
      els.diaryContent.innerHTML = '<div class="pending">重新生成中…</div>';
    });
    diaryInited = true;
  }
  // 每次打开：处理之前没生成的日记（backlog）
  try {
    await window.api.scanDiaryBacklog();
  } catch (e) {
    /* ignore */
  }
  await renderCalendar();
  await loadDiary(calState.selected);
}

// ---------- 手动日记（随笔 / 微信收藏夹式）----------
const notesState = { year: 0, month: 0, selected: null };
let notesInited = false;
let notesDirty = false;

// 标签提取（与后端一致）：#标签#（可含空格）或 #标签（至空白/# 即止）
function extractTagsFromText(text) {
  if (!text) return [];
  const tags = new Set();
  const re = /#([^#\s\n]+)#|#([^\s#\n]+)/g;
  let m;
  while ((m = re.exec(text))) {
    let t = (m[1] != null ? m[1] : m[2]).trim();
    t = t.replace(/[，。、！？!?；;：:，,.]+$/, '').trim();
    if (t) tags.add(t);
  }
  return Array.from(tags);
}

// 存储用消毒：白名单标签 + 属性，剥离脚本/事件/非法 URL
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const ALLOWED = new Set(['P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'IMG', 'A']);
  const out = doc.createElement('div');
  function walk(node, target) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        target.appendChild(doc.createTextNode(child.nodeValue));
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (!ALLOWED.has(tag)) {
          walk(child, target); // 反包：保留子孙文本
          continue;
        }
        const el = doc.createElement(tag);
        if (tag === 'IMG') {
          const src = child.getAttribute('src') || '';
          if (/^(file:|data:)/i.test(src)) el.setAttribute('src', src);
          const alt = child.getAttribute('alt') || '';
          if (alt) el.setAttribute('alt', alt);
        } else if (tag === 'A') {
          const href = child.getAttribute('href') || '';
          if (/^(https?:|file:)/i.test(href)) {
            el.setAttribute('href', href);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
        }
        walk(child, el);
        target.appendChild(el);
      }
    }
  }
  walk(doc.body, out);
  return out.innerHTML;
}

// 编辑中实时清理危险节点/属性（失焦时调用，避免影响输入光标）
function cleanEditorInPlace() {
  const FORBIDDEN = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (FORBIDDEN.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const n = attr.name.toLowerCase();
        const v = attr.value || '';
        if (n.startsWith('on')) child.removeAttribute(attr.name);
        else if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(v)) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(els.noteEditor);
}

function renderNoteTagChips(tags) {
  els.noteTags.innerHTML = '';
  if (!tags || !tags.length) {
    els.noteTagsHint.style.display = '';
    return;
  }
  els.noteTagsHint.style.display = 'none';
  tags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = '#' + t;
    els.noteTags.appendChild(chip);
  });
}

async function renderNotesCalendar() {
  const y = notesState.year;
  const m = notesState.month;
  els.notesCalTitle.textContent = `${y}年${m}月`;
  let markers = {};
  try {
    markers = await window.api.getMonthMarkers(y, m);
  } catch (e) {
    /* ignore */
  }
  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  els.notesCalGrid.innerHTML = '';
  cells.forEach((d) => {
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (d === null) {
      cell.classList.add('other');
      els.notesCalGrid.appendChild(cell);
      return;
    }
    cell.classList.add('in-month');
    const dd = String(d).padStart(2, '0');
    const mk = markers[dd];
    if (mk && mk.hasNote) cell.classList.add('has-note');
    cell.textContent = d;
    const full = `${y}-${String(m).padStart(2, '0')}-${dd}`;
    if (full === notesState.selected) cell.classList.add('selected');
    cell.addEventListener('click', () => selectNoteDay(full));
    els.notesCalGrid.appendChild(cell);
  });
}

async function loadNote(full) {
  let note = null;
  try {
    note = await window.api.getNote(full);
  } catch (e) {
    /* ignore */
  }
  if (note && note.html) {
    els.noteEditor.innerHTML = note.html;
  } else {
    els.noteEditor.innerHTML = '';
  }
  renderNoteTagChips(note && note.tags ? note.tags : []);
  notesDirty = false;
}

async function saveNoteNow(showHint) {
  const rawHtml = els.noteEditor.innerHTML;
  const html = sanitizeHtml(rawHtml);
  const text = els.noteEditor.innerText || '';
  const tags = extractTagsFromText(text);
  renderNoteTagChips(tags);
  try {
    const res = await window.api.saveNote({ date: notesState.selected, html, text, tags });
    notesDirty = false;
    if (showHint) {
      els.noteSaveHint.textContent = res && res.deleted ? '已清空' : '已保存 ✓';
      setTimeout(() => (els.noteSaveHint.textContent = ''), 2000);
    }
    await renderNotesCalendar();
    await refreshNoteTagCloud();
  } catch (e) {
    if (showHint) {
      els.noteSaveHint.textContent = '保存失败：' + e.message;
    }
  }
}

const notesAutoSave = debounce(() => saveNoteNow(false), 1200);

async function selectNoteDay(full) {
  // 切换前先保存当前（若有改动）
  if (notesDirty) await saveNoteNow(false);
  notesState.selected = full;
  els.noteSelected.textContent = `所选日期：${full}`;
  await renderNotesCalendar();
  await loadNote(full);
}

async function refreshNoteTagCloud() {
  let tags = [];
  try {
    tags = await window.api.getNoteTags();
  } catch (e) {
    return;
  }
  if (!tags || !tags.length) {
    els.noteTagCloud.innerHTML = '<span class="muted">（还没有标签，写日记时加 #标签 试试）</span>';
    return;
  }
  els.noteTagCloud.innerHTML = '';
  tags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag cloud-tag';
    chip.innerHTML = `#${escapeHtml(t.tag)} <b>${t.count}</b>`;
    chip.title = `点击查看含「${t.tag}」的 ${t.count} 天`;
    chip.addEventListener('click', () => showTagResults(t));
    els.noteTagCloud.appendChild(chip);
  });
}

function showTagResults(t) {
  els.noteTagResults.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'tlr-head';
  head.textContent = `含标签 #${t.tag} 的 ${t.dates.length} 天：`;
  els.noteTagResults.appendChild(head);
  const list = document.createElement('div');
  list.className = 'tlr-list';
  t.dates
    .slice()
    .sort()
    .reverse()
    .forEach((date) => {
      const btn = document.createElement('button');
      btn.className = 'btn ghost tlr-item';
      btn.textContent = date;
      btn.addEventListener('click', () => switchToNoteDate(date));
      list.appendChild(btn);
    });
  els.noteTagResults.appendChild(list);
}

async function switchToNoteDate(date) {
  const [y, m] = date.split('-').map(Number);
  notesState.year = y;
  notesState.month = m;
  await selectNoteDay(date);
  els.noteEditor.focus();
}

function insertImageAtCursor(url) {
  els.noteEditor.focus();
  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount && els.noteEditor.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(els.noteEditor);
    range.collapse(false);
  }
  range.deleteContents();
  const img = document.createElement('img');
  img.src = url;
  img.className = 'note-img';
  range.insertNode(img);
  const br = document.createElement('br');
  const after = document.createRange();
  after.setStartAfter(img);
  after.collapse(true);
  after.insertNode(br);
  const sel2 = window.getSelection();
  const fin = document.createRange();
  fin.setStartAfter(br);
  fin.collapse(true);
  sel2.removeAllRanges();
  sel2.addRange(fin);
  notesDirty = true;
}

async function handlePastedFiles(files) {
  for (const file of files) {
    if (!/^image\//.test(file.type)) continue;
    const buf = await file.arrayBuffer();
    const ext = (file.type.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg');
    try {
      const res = await window.api.saveNoteImage({
        date: notesState.selected,
        ext,
        buf: Array.from(new Uint8Array(buf)),
      });
      insertImageAtCursor(res.url);
    } catch (e) {
      log('error', '笔记图片保存失败：' + e.message);
    }
  }
}

async function initNotes() {
  if (!notesInited) {
    const n = new Date();
    notesState.year = n.getFullYear();
    notesState.month = n.getMonth() + 1;
    notesState.selected = dayKeyLocal(n);

    els.notesCalPrev.addEventListener('click', () => {
      notesState.month--;
      if (notesState.month < 1) {
        notesState.month = 12;
        notesState.year--;
      }
      renderNotesCalendar();
    });
    els.notesCalNext.addEventListener('click', () => {
      notesState.month++;
      if (notesState.month > 12) {
        notesState.month = 1;
        notesState.year++;
      }
      renderNotesCalendar();
    });
    els.notesCalToday.addEventListener('click', () => {
      const t = new Date();
      notesState.year = t.getFullYear();
      notesState.month = t.getMonth() + 1;
      renderNotesCalendar();
      selectNoteDay(dayKeyLocal(t));
    });

    // 文本输入：标记 dirty + 自动保存（消毒在保存时进行）
    els.noteEditor.addEventListener('input', () => {
      notesDirty = true;
      notesAutoSave();
    });
    // 粘贴：图片拦截保存，文本放行后消毒
    els.noteEditor.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (items) {
        const imgs = [];
        for (const it of items) {
          if (it.kind === 'file' && it.type && it.type.startsWith('image/')) imgs.push(it);
        }
        if (imgs.length) {
          e.preventDefault();
          const files = imgs.map((it) => it.getAsFile()).filter(Boolean);
          await handlePastedFiles(files);
          return;
        }
      }
      // 文本/富文本：交给浏览器默认处理，稍后消毒 + 自动保存
      setTimeout(() => {
        cleanEditorInPlace();
        notesDirty = true;
        notesAutoSave();
      }, 0);
    });
    // 拖入图片
    els.noteEditor.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    els.noteEditor.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length) await handlePastedFiles(files);
    });
    // 失焦保存
    els.noteEditor.addEventListener('blur', () => {
      cleanEditorInPlace();
      if (notesDirty) saveNoteNow(false);
    });

    els.noteSave.addEventListener('click', () => saveNoteNow(true));
    els.noteClear.addEventListener('click', () => {
      if (!els.noteEditor.innerText.trim() && !els.noteEditor.querySelector('img')) return;
      if (confirm('确定清空当天的日记？清空后保存将删除该日记与附带的照片。')) {
        els.noteEditor.innerHTML = '';
        renderNoteTagChips([]);
        saveNoteNow(true);
      }
    });

    notesInited = true;
  }
  await renderNotesCalendar();
  await loadNote(notesState.selected);
  await refreshNoteTagCloud();
}

// ---------- 看板页：多维可视化 ----------
let dashboardInited = false;
const charts = {};

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    delete charts[key];
  }
}

function renderStatCards(d) {
  const t = d.totals;
  const fmtMin = (m) => (m >= 60 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`);
  const cards = [
    { v: fmtMin(t.minutes), l: '总记录时长' },
    { v: fmtMin(t.categorizedMinutes), l: '已分类时长' },
    { v: t.uncategorizedMinutes > 0 ? fmtMin(t.uncategorizedMinutes) : '—', l: '未分类时长' },
    { v: t.daysWithData, l: '有数据天数' },
    { v: t.topCategory || '—', l: '主要类型' },
    { v: t.distinctProjects, l: '涉及项目' },
    { v: t.distinctSoftware, l: '涉及软件' },
  ];
  els.statCards.innerHTML = cards
    .map(
      (c) =>
        `<div class="stat-card"><div class="v">${escapeHtml(
          String(c.v)
        )}</div><div class="l">${c.l}</div></div>`
    )
    .join('');
}

const CAT_COLORS = {
  娱乐: '#f59e0b',
  工作: '#2f6df6',
  学习: '#2bb673',
  社交: '#a855f7',
  其他: '#9aa3b2',
};

function renderCharts(d) {
  if (typeof window.Chart === 'undefined') {
    els.statCards.insertAdjacentHTML(
      'afterend',
      '<div class="tl-empty">图表库未加载（Chart.js 缺失），统计卡片仍可正常显示。</div>'
    );
    return;
  }
  const cmap = d.categorySet;

  destroyChart('category');
  charts.category = new window.Chart($('chartCategory'), {
    type: 'doughnut',
    data: {
      labels: cmap,
      datasets: [
        {
          data: cmap.map((c) => d.categoryMinutes[c]),
          backgroundColor: cmap.map((c) => CAT_COLORS[c]),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'right' } },
    },
  });

  const sw = d.softwareCounts.slice(0, 12);
  destroyChart('software');
  charts.software = new window.Chart($('chartSoftware'), {
    type: 'bar',
    data: {
      labels: sw.map((s) => s.name),
      datasets: [
        { label: '出现次数', data: sw.map((s) => s.count), backgroundColor: '#2f6df6' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
    },
  });

  const pr = d.projectMinutes.slice(0, 12);
  destroyChart('project');
  charts.project = new window.Chart($('chartProject'), {
    type: 'bar',
    data: {
      labels: pr.map((s) => s.project),
      datasets: [
        {
          label: '专注分钟',
          data: pr.map((s) => s.minutes),
          backgroundColor: pr.map((s) => CAT_COLORS[s.category] || '#9aa3b2'),
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
    },
  });

  const ts = d.timeSeries;
  destroyChart('series');
  charts.series = new window.Chart($('chartSeries'), {
    type: 'bar',
    data: {
      labels: ts.map((p) => p.label),
      datasets: cmap.map((c) => ({
        label: c,
        data: ts.map((p) => p[c]),
        backgroundColor: CAT_COLORS[c],
        stack: 's',
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: '分钟' } },
      },
    },
  });

  destroyChart('line');
  charts.line = new window.Chart($('chartLine'), {
    type: 'line',
    data: {
      labels: ts.map((p) => p.label),
      datasets: [
        {
          label: '总时长(分钟)',
          data: ts.map((p) => p.total),
          borderColor: '#2f6df6',
          backgroundColor: 'rgba(47,109,246,0.15)',
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { title: { display: true, text: '分钟' } } },
    },
  });
}

async function loadDashboard() {
  const type = els.dashType.value;
  const value = els.dashDate.value || null;
  let data;
  try {
    data = await window.api.getDashboard(type, value);
  } catch (e) {
    log('error', '看板加载失败：' + e.message);
    return;
  }
  renderStatCards(data);
  renderCharts(data);
}

async function initDashboard() {
  if (!dashboardInited) {
    els.dashDate.value = dayKeyLocal(new Date());
    els.dashType.addEventListener('change', loadDashboard);
    els.dashDate.addEventListener('change', loadDashboard);
    els.dashRefresh.addEventListener('click', loadDashboard);
    dashboardInited = true;
  }
  await loadDashboard();
}

// ---------- 问答页：agentic 检索问答 ----------
let qaInited = false;
function initQa() {
  if (!qaInited) {
    els.qaAsk.addEventListener('click', doAsk);
    els.qaInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doAsk();
    });
    qaInited = true;
  }
}
async function doAsk() {
  const q = (els.qaInput.value || '').trim();
  if (!q) {
    els.qaStatus.textContent = '请先输入一个问题。';
    return;
  }
  els.qaAsk.disabled = true;
  els.qaStatus.textContent = '正在检索并思考（最多 3 轮检索）…';
  els.qaSteps.innerHTML = '';
  els.qaAnswer.textContent = '';
  let res;
  try {
    res = await window.api.askQuestion(q);
  } catch (e) {
    els.qaStatus.textContent = '问答失败：' + e.message;
    els.qaAsk.disabled = false;
    return;
  }
  renderQaSteps(res.steps);
  els.qaStatus.textContent = `检索完成：共 ${res.collectedCount} 条相关片段`;
  els.qaAnswer.textContent = res.answer || '（无回答）';
  els.qaAsk.disabled = false;
}
function renderQaSteps(steps) {
  if (!steps || !steps.length) {
    els.qaSteps.innerHTML = '<div class="muted">未执行检索。</div>';
    return;
  }
  els.qaSteps.innerHTML = steps
    .map((s) => {
      if (s.error) {
        return `<div class="qa-step err">第 ${s.round} 轮：检索出错 ${escapeHtml(s.error)}</div>`;
      }
      const rs = (s.results || [])
        .map(
          (r) =>
            `<span class="qa-q">${escapeHtml(r.source)} ${escapeHtml(r.from)}~${escapeHtml(
              r.to
            )} [${escapeHtml((r.keywords || []).join('/'))}] → ${r.count} 条</span>`
        )
        .join(' ');
      const done = s.done ? '<span class="qa-done">（已足够，停止检索）</span>' : '';
      return `<div class="qa-step">第 ${s.round} 轮：${rs || '（无查询，视为已足够）'}${done}</div>`;
    })
    .join('');
}

// ---------- 按钮 ----------
els.btnStart.addEventListener('click', async () => {
  await window.api.start();
});
els.btnStop.addEventListener('click', async () => {
  await window.api.stop();
});
els.btnCheck.addEventListener('click', async () => {
  els.btnCheck.disabled = true;
  log('info', '正在检测 Ollama…');
  const r = await window.api.checkOllama();
  if (!r.reachable) {
    log('error', `Ollama 不可达（${r.error || '连接失败'}）。请确认已启动 Ollama。`);
  } else if (!r.modelInstalled) {
    log('warn', `Ollama 已连接，但未安装模型 “${els.fModel.value}”。请执行：ollama pull ${els.fModel.value}`);
  } else {
    log('info', `Ollama 正常，模型 “${els.fModel.value}” 已安装。`);
  }
  els.btnCheck.disabled = false;
});

// ---------- 订阅 ----------
window.api.onStatus((p) => setRunning(p.running));
window.api.onScreenshot((p) => renderScreenshot(p));
window.api.onRecord((p) => renderActivity(p));
window.api.onLog((p) => log(p.level, p.msg));
window.api.onSummaryStatus((p) => setSummaryStatus(p));
window.api.onSummary(async () => {
  // 新汇总完成：若正在看动态页则刷新热力图与时间线
  if (!els.tabDynamic.classList.contains('hidden')) {
    await renderHeatmap();
    await loadTimeline(true);
  }
});

window.api.onDiaryStatus((p) => {
  const active = p.diarying || p.queueLength > 0;
  if (els.diaryStatus) {
    els.diaryStatus.textContent = active ? `日记生成中（队列 ${p.queueLength}）` : '';
  }
});

window.api.onDiary((d) => {
  // 日记生成完成：若正在看日记页则刷新日历标记，且命中选中日则重渲染
  if (!els.tabDiary.classList.contains('hidden')) {
    renderCalendar();
    if (d.date === calState.selected) renderDiary(d);
  }
});

// ---------- 初始化 ----------
(async () => {
  await loadConfigToForm();
  // 主动拉取一次当前运行状态，确保「开始/停止」按钮状态与实际情况一致
  // （自动启动时 start() 发出的 status 可能早于本页面注册监听而丢失）
  const state = await window.api.getState().catch(() => null);
  if (state) setRunning(state.running);
  const st = await window.api.getSummaryStatus().catch(() => null);
  if (st) setSummaryStatus(st);
  await refreshStorageInfo();
  setInterval(refreshStorageInfo, 60 * 1000); // 每分钟刷新空间占用
  log('info', '已就绪。点击“开始”启动记录，或先“检测 Ollama”。切到“动态”查看汇总与热力图。');
})();

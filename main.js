'use strict';

const { app, BrowserWindow, ipcMain, powerMonitor, Tray, Menu, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const { execFile, execSync, spawn } = require('child_process');

const config = require('./config');
const storage = require('./storage');
const analyzer = require('./analyzer');
const summary = require('./summary');
const diary = require('./diary');
const notes = require('./notes');
const analytics = require('./analytics');
const qa = require('./qa');
const { captureScreenshot } = require('./capture');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { getForegroundApp } = require('./foreground');

// 打包后部分显卡/驱动下渲染进程初始化失败会导致整窗白屏；强制软件渲染兜底。
// 若确为 GPU 问题，这一行即可直接消除白屏（代价：图表渲染走软件，略慢但正常）。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// 崩溃兜底：把未捕获异常/拒绝写入临时日志，便于排查；同时避免单点异常拖垮整个记录仪
function logCrash(tag, e) {
  try {
    const msg = `[${new Date().toISOString()}] ${tag}: ${e && e.stack ? e.stack : e}\n`;
    fs.appendFileSync(path.join(os.tmpdir(), 'lifelens-crash.log'), msg);
  } catch (_) {}
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

// 单实例锁：保证全系统只有一个 LifeLens 在跑，避免双托盘 / 抢文件 / 多实例叠加吃内存。
// 启动先清掉其它残留 LifeLens.exe（含旧版本），再由本实例抢锁；若仍抢不到（极罕见并发），
// 则退出，由已存在的实例通过 second-instance 事件把窗口提到前台。
function killOtherInstances() {
  try {
    const me = String(process.pid);
    const out = execSync('tasklist /FI "IMAGENAME eq LifeLens.exe" /NH', { windowsHide: true }).toString();
    const pids = [...out.matchAll(/^LifeLens\.exe\s+(\d+)/gim)].map((m) => m[1]).filter((p) => p !== me);
    for (const p of pids) {
      try {
        execSync(`taskkill /PID ${p} /F`, { windowsHide: true });
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }
}
killOtherInstances();
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ===== Ollama 自管（确保 LifeLens 永不依赖 Ollama 桌面 GUI）=====
// 思路：LifeLens 只跟后台 ollama serve 对话。若检测到服务没起，就自己无界面拉起一个，
// 这样用户永远不用开那个占 ~580MB 的 Ollama 桌面图标，也不会因关了图标而离线。
// 同时给 serve 设资源护栏：限制线程数（留 CPU 余量）、最多常驻 1 个模型。
let ollamaManaged = false; // 是否由本进程拉起（用于退出时决定是否清理）
function ensureOllama() {
  const base = (cfg.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  return fetch(`${base}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => {
      if (ok) {
        logOllamaMode();
        return true;
      }
      // 不可达 → 无界面拉起 serve（detached，不弹窗口，退出不影响系统其它 ollama）
      try {
        const cores = require('os').cpus().length || 4;
        const half = Math.max(1, Math.floor(cores / 2));
        const env = Object.assign({}, process.env, {
          OLLAMA_NUM_THREADS: String(half),
          OLLAMA_MAX_LOADED_MODELS: '1',
        });
        const child = spawn('ollama', ['serve'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env,
        });
        child.unref();
        ollamaManaged = true;
        send('log', { level: 'info', msg: '已无界面启动 Ollama 服务（无需打开 Ollama 桌面程序）' });
      } catch (e) {
        send('log', { level: 'warn', msg: `无法自动启动 Ollama：${e.message}（请手动启动 ollama serve）` });
      }
      logOllamaMode();
      return true;
    });
}

// 在「日志」里明确当前推理占用模式，方便用户一眼确认“没在抢显卡”
function logOllamaMode() {
  const mode = (cfg && cfg.analysisGpuMode) || 'cpu';
  if (mode === 'cpu') {
    send('log', {
      level: 'info',
      msg: '资源模式：模型推理走 CPU（num_gpu_layers=0），GPU 显存已让给你的 AI 项目',
    });
  } else {
    send('log', {
      level: 'warn',
      msg: '资源模式：模型推理走 GPU（analysisGpuMode=gpu），会与你的其它 AI 任务抢显卡',
    });
  }
}

// 打包态（asar 只读）：截图/JSON/设置都落在"项目目录下的 data"，
// 即 <安装目录>/data（与开发态一致，可直接复用历史记录），不写 C 盘 AppData。
// 通过 electron-builder 便携版注入的 PORTABLE_EXECUTABLE_DIR 定位到 <安装目录>/dist 的上一级。
let cfg;
if (app.isPackaged) {
  // PORTABLE_EXECUTABLE_DIR 由 portable 构建注入（形如 <安装目录>/dist）；
  // 注意不能在这里回退到 app.getPath('exe') —— portable 版它永远指向 %TEMP% 下的解压目录，
  // 会把 data 写进临时文件夹后在系统清理时静默丢失。非便携安装时 exe 就在安装目录根部。
  const projRoot = process.env.PORTABLE_EXECUTABLE_DIR
    ? path.dirname(process.env.PORTABLE_EXECUTABLE_DIR) // <安装目录>/dist -> <安装目录>
    : path.dirname(app.getPath('exe')); // 常规安装：exe 直接位于安装目录
  const dataHome = path.join(projRoot, 'data');
  config.setSettingsBase(dataHome);
  cfg = config.loadConfig();
  cfg.dataDir = dataHome;
} else {
  cfg = config.loadConfig();
}

let mainWindow = null;
let timer = null;
let running = false;
let busy = false; // 防止上一轮截屏分析未结束就叠加下一轮
let lastFgKey = null;       // 上次前台窗口指纹（事件驱动用）
let lastCaptureAt = 0;      // 上次真正截屏时刻(ms)（同窗口节流用）
let lastSwitchAt = 0;       // 上次窗口切换时刻(ms)

// ===== 托盘常驻 =====
let tray = null;
let isQuiting = false; // “退出”菜单置真，window close 才真正退出；否则只是最小化到托盘
// 开机自启通过 --hidden 启动：窗口不闪现，直接驻留托盘
const startHidden = process.argv.includes('--hidden');

// 图标资源（assets/icon.png 内嵌 asar，运行时按需加载，托盘/窗口/通知共用）
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
let _cachedIcon = null;
function getAppIcon() {
  if (!_cachedIcon) _cachedIcon = nativeImage.createFromPath(ICON_PATH);
  return _cachedIcon;
}

// ===== 十分钟汇总调度 =====
let summaryQueue = []; // 待汇总的桶 id（升序处理以保证 project 连续性）
let summarizing = false; // 正在处理队列
let summaryTimer = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pushSummaryStatus() {
  send('summaryStatus', {
    summarizing,
    queueLength: summaryQueue.length,
  });
}

async function processSummaryQueue() {
  if (summarizing) return;
  if (summaryQueue.length === 0) {
    pushSummaryStatus();
    return;
  }
  summarizing = true;
  const bucketId = summaryQueue.shift();
  pushSummaryStatus();
  try {
    const records = summary.getRecordsInBucket(cfg.dataDir, bucketId);
    // 连续性：直接读取“上一个 10 分钟桶”的磁盘汇总作为参考（而非依赖易被打乱的队列顺序/全局变量）。
    // 这样无论 backlog 与运行时桶以何种顺序入队，project 名续接都基于已落盘的真实结果。
    const start = summary.bucketStart(bucketId);
    const prevBucketId = summary.bucketId(new Date(start.getTime() - summary.BUCKET_MS));
    const prevSummary =
      summary.loadDaySummaries(cfg.dataDir, summary.bucketStart(prevBucketId))[prevBucketId] ||
      null;
    const result = await summary.generateSummary(cfg, bucketId, records, prevSummary);
    summary.saveSummary(cfg.dataDir, result);
    send('summary', result);
    send('log', { level: 'info', msg: `已汇总 ${bucketId}：${result.project || '（未命名）'} [${result.category}]` });
  } catch (e) {
    // 写一条 error 状态的汇总，避免该桶被反复重试
    const { start, end } = summary.bucketRange(bucketId);
    summary.saveSummary(cfg.dataDir, {
      bucket: bucketId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      project: '',
      category: '其他',
      description: '',
      software: [],
      todos: [],
      status: 'error',
      error: e.message,
      recordCount: 0,
    });
    send('log', { level: 'error', msg: `汇总失败 ${bucketId}：${e.message}` });
  } finally {
    summarizing = false;
    pushSummaryStatus();
    // 继续处理队列中剩余项
    if (summaryQueue.length > 0) processSummaryQueue();
  }
}

function enqueueSummary(bucketId) {
  if (!summaryQueue.includes(bucketId)) summaryQueue.push(bucketId);
  processSummaryQueue();
}

// 扫描 backlog（有记录但未汇总的桶）并排队
function runBacklogScan() {
  const missing = summary.collectBacklog(cfg.dataDir, new Date());
  missing.forEach((b) => enqueueSummary(b));
  if (missing.length) {
    send('log', { level: 'info', msg: `发现 ${missing.length} 个未汇总时间段，已加入队列依次处理` });
  }
}

// 每分钟检查一次是否到了“刚结束的 10 分钟桶”需要入队；
// 用较短的轮询 + 间隔配置，保证到点触发且配置可热更新。
function startSummaryScheduler() {
  if (summaryTimer) clearInterval(summaryTimer);
  const tickMs = Math.max(30 * 1000, cfg.summaryIntervalMin * 60 * 1000 / 6);
  let lastEnqueuedBucket = null;
  summaryTimer = setInterval(() => {
    const now = new Date();
    // 已结束的桶 = （当前时间 - 一个桶长度）所在桶
    const endedBucket = summary.bucketId(new Date(now.getTime() - summary.BUCKET_MS));
    if (endedBucket !== lastEnqueuedBucket) {
      // 若尚未在该桶产生汇总，则入队
      const start = summary.bucketStart(endedBucket);
      const daySums = summary.loadDaySummaries(cfg.dataDir, start);
      if (!daySums[endedBucket]) {
        lastEnqueuedBucket = endedBucket;
        enqueueSummary(endedBucket);
      }
    }
  }, tickMs);
  // 启动即处理“开始之前已结束”的桶
  const endedBucket = summary.bucketId(new Date(Date.now() - summary.BUCKET_MS));
  const start = summary.bucketStart(endedBucket);
  const daySums = summary.loadDaySummaries(cfg.dataDir, start);
  if (!daySums[endedBucket]) enqueueSummary(endedBucket);
}

// ===== 旧截图保留清理（防止 D 盘爆满）=====
function startRetentionCleaner() {
  const run = () => {
    try {
      const deleted = storage.cleanupScreenshots(cfg.dataDir, cfg.screenshotRetentionDays);
      if (deleted > 0) {
        send('log', {
          level: 'info',
          msg: `已清理 ${deleted} 张超过 ${cfg.screenshotRetentionDays} 天的旧截图`,
        });
      }
    } catch (e) {
      send('log', { level: 'warn', msg: `旧截图清理失败：${e.message}` });
    }
    // —— 文本归档：把超出 LIVE 窗口的整月抽文本、删原始小时 JSON ——
    try {
      const ar = storage.archiveOldRecords(cfg.dataDir, cfg.textRetentionDays, cfg.maxArchiveAgeDays);
      if (ar.archivedMonths > 0) {
        send('log', {
          level: 'info',
          msg: `已归档 ${ar.archivedMonths} 个月、${ar.archivedEntries} 条文本，删除 ${ar.deletedHourFiles} 个旧小时文件`,
        });
      }
      if (ar.deletedArchives > 0) {
        send('log', { level: 'info', msg: `已清理 ${ar.deletedArchives} 个超期归档文件` });
      }
      (ar.errors || []).forEach((m) => send('log', { level: 'warn', msg: `归档：${m}` }));
    } catch (e) {
      send('log', { level: 'warn', msg: `文本归档失败：${e.message}` });
    }
  };
  run(); // 启动即清理一次（处理历史堆积）
  setInterval(run, 60 * 60 * 1000); // 之后每小时一次
}

// ===== 日记（二阶汇总）调度 =====
let diaryQueue = []; // 待生成日记的日期（YYYY-MM-DD）
let diarying = false; // 正在处理队列

function pushDiaryStatus() {
  send('diaryStatus', {
    diarying,
    queueLength: diaryQueue.length,
  });
}

async function processDiaryQueue() {
  if (diarying) return;
  if (diaryQueue.length === 0) {
    pushDiaryStatus();
    return;
  }
  diarying = true;
  const date = diaryQueue.shift();
  pushDiaryStatus();
  try {
    const sums = summary.loadDaySummaries(cfg.dataDir, date);
    const hasOk = Object.keys(sums).some((b) => sums[b].status === 'ok');
    if (!hasOk) {
      send('log', { level: 'warn', msg: `跳过 ${date} 日记：当天无有效汇总` });
    } else {
      const result = await diary.generateDiary(cfg, date, sums);
      diary.saveDiary(cfg.dataDir, result);
      send('diary', result);
      send('log', { level: 'info', msg: `已生成 ${date} 日记` });
    }
  } catch (e) {
    send('log', { level: 'error', msg: `日记生成失败 ${date}：${e.message}` });
  } finally {
    diarying = false;
    pushDiaryStatus();
    if (diaryQueue.length > 0) processDiaryQueue();
  }
}

function enqueueDiary(date) {
  if (!diaryQueue.includes(date)) diaryQueue.push(date);
  processDiaryQueue();
}

// 扫描 backlog（有汇总但无日记的日期）并排队
function runDiaryBacklogScan() {
  const missing = diary.collectDiaryBacklog(cfg.dataDir);
  missing.forEach((d) => enqueueDiary(d));
  if (missing.length) {
    send('log', { level: 'info', msg: `发现 ${missing.length} 天未生成日记，已加入队列依次处理` });
  }
}

// ===== 20 秒截屏 + 单次分析 =====
// 代表帧映射：bucketId -> 该 10 分钟桶已落盘的代表截图路径。
// 开启 keepRepresentativeOnly 时，每个桶只在首帧落盘，其余 20s 帧仅分析、不写盘，
// 其 imagePath 指向代表帧（节省约 6 倍磁盘）。
const repFrameByBucket = new Map();

// —— 帧去重 + Ollama 掉线自愈 状态 ——
let lastFrameHash = null;        // 上一帧截图指纹（JPEG 字节 md5）
let ollamaOnline = true;         // 当前是否在线（自愈用）
let ollamaLoggedOffline = false; // 避免离线状态重复刷 log
let offlineProbeTick = 0;        // 离线期间每 N 轮探测一次恢复

// —— 空闲 / 锁屏暂停 + 智能间隔 状态 ——
let screenLocked = false;        // 锁屏/休眠 → 暂停采集
let lastTickDuration = 0;        // 上一轮耗时（智能间隔用）
const INTERVAL_GAP_MS = 2000;    // 分析结束后留出的缓冲，避免与下一轮重叠

// 判定 fetch 失败是否“连不上 Ollama”（而非模型 bug / 分析超时）
function isConnError(e) {
  const m = (e && e.message) || '';
  const cause = e && e.cause && e.cause.message ? e.cause.message : '';
  // ponytail: 仅匹配连接层错误；AbortSignal 的 "timed out" 不匹配，避免误判离线
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(m + ' ' + cause);
}

// ===== 前台窗口检测（Windows）=====
// 实现见 ./foreground.js（用 user32 GetForegroundWindow，.ps1 文件方式调用，避开 -Command 内联 Add-Type 被拦的问题）。
// 同时服务「隐私排除」与「持续活动提醒」两个功能。

// 前台窗口是否命中隐私排除名单（进程名 / 标题子串匹配，均转小写）
function isExcluded(fg, ex) {
  if (!fg) return false;
  const proc = String(fg.process || '').toLowerCase();
  const title = String(fg.title || '').toLowerCase();
  const apps = (ex.apps || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const titles = (ex.titles || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  for (const a of apps) if (proc.includes(a)) return true;
  for (const t of titles) if (title.includes(t)) return true;
  return false;
}

// ===== 分层分析辅助（标题优先，省 GPU）=====
// 这些应用“画面以图像/设计/视频/聊天为主”，窗口标题通常不足以描述内容 → 始终调用多模态模型
function shouldSkipModel(fg, cfg) {
  const proc = String(fg.process || '').toLowerCase().replace(/\.exe$/, '');
  const alwaysModel = cfg.titleAlwaysModelApps || [];
  if (alwaysModel.some((x) => proc.includes(x))) return false;
  const title = String(fg.title || '').trim();
  if (!title) return false; // 无标题 → 无法从标题判断 → 用模型
  if (title.toLowerCase().replace(/\.exe$/, '') === proc) return false; // 标题仅是应用名 → 用模型
  return true; // 标题含具体内容（文件/页面/文档）→ 标题优先，跳过模型
}

// 防御层：任何来源的外部字符串（窗口标题、模型输出）落库前都剥离「替换符 U+FFFD」——
// 这是解码失败留下的不可逆损坏标记，绝不该沉淀进数据（曾导致乱码反复出现）。
// 注意：只去除 U+FFFD，不破坏正常中文/emoji（它们不是替换符）。
function sanitize(s) {
  if (!s) return '';
  return String(s).replace(/�/g, '').trim();
}

// 由“进程 + 窗口标题”直接生成一句活动描述（不调模型）
function buildTitleActivity(fg) {
  const proc = sanitize(String(fg.process || '').replace(/\.exe$/i, ''));
  const title = sanitize(String(fg.title || '').trim());
  if (!title) return `使用 ${proc}`;
  return `使用 ${proc}：${title}`;
}

// ===== 持续活动提醒（防沉迷 / 正念）=====
// 检测“前台应用”连续停留时长；超过阈值且命中提醒名单 → 弹系统通知。
// 独立于截屏采集，开机即生效；锁屏/空闲不计时（视为断档，回来重新计时）。
let reminderTimer = null;
let fgReminderApp = '';      // 当前持续的前台应用（进程名小写，去 .exe）
let fgReminderSince = 0;     // 该应用开始持续的时刻(ms)
const fgReminderLast = {};   // app -> 上次提醒时刻(ms)，用于冷却

const GAME_APPS = ['steam', 'epicgameslauncher', 'battlenet', 'xbox', 'origin', 'galaxyclient', 'ubisoftconnect', 'roblox', 'minecraft', 'leagueclient', 'dota2', 'csgo', 'valorant'];
const VIDEO_APPS = ['potplayer', 'vlc', 'mpv', 'kmplayer', 'iqiyi', 'youku', 'tencentvideo', 'lecloud', 'bilibili', 'pptv'];
const BROWSER_APPS = ['chrome', 'msedge', 'brave', 'firefox', 'opera', 'iexplore', 'safari', '360se', 'ucbrowser', 'qqbrowser', 'maxthon'];
const VIDEO_TITLE_KEYS = ['youtube', 'bilibili', 'b站', '哔哩', 'netflix', '腾讯视频', '爱奇艺', '优酷', '油管', 'watch', '咪咕'];

function categorizeApp(app, title) {
  const a = String(app).toLowerCase();
  if (GAME_APPS.some((x) => a.includes(x))) return 'game';
  if (VIDEO_APPS.some((x) => a.includes(x))) return 'video';
  if (BROWSER_APPS.some((x) => a.includes(x))) {
    const t = String(title || '').toLowerCase();
    if (VIDEO_TITLE_KEYS.some((k) => t.includes(k))) return 'video';
    return 'browser';
  }
  return 'other';
}

function reminderMessage(cat, app, mins) {
  if (cat === 'game') return `你已经在玩游戏 ${mins} 分钟了，起来活动活动吧 🎮`;
  if (cat === 'video') return `你已经连续看了 ${mins} 分钟视频，眼睛该歇歇了 📺`;
  if (cat === 'browser') return `你已经刷了 ${mins} 分钟网页，记得休息一下 🌐`;
  return `你已经在「${app}」上连续 ${mins} 分钟了，记得休息一下哦`;
}

function fireReminder(app, title, mins) {
  const cat = categorizeApp(app, title);
  const message = reminderMessage(cat, app, mins);
  try {
    new Notification({ title: 'LifeLens 提醒', body: message, icon: getAppIcon() }).show();
  } catch (e) {
    send('log', { level: 'warn', msg: `系统通知弹出失败，已记入日志：${e.message}` });
  }
  send('reminder', { app, title, mins, category: cat, message });
  send('log', { level: 'info', msg: `持续活动提醒：${app} 已连续 ${mins} 分钟（${cat}）` });
}

async function pollReminder() {
  if (!cfg.reminderEnabled) return;
  // 锁屏/挂起：视为断档
  if (screenLocked) { fgReminderApp = ''; fgReminderSince = 0; return; }
  // 空闲：离开即断档，回来重新计时
  if (typeof powerMonitor.getSystemIdleTime === 'function' &&
      powerMonitor.getSystemIdleTime() >= cfg.idleThresholdSec) {
    fgReminderApp = ''; fgReminderSince = 0; return;
  }
  let fg = null;
  try { fg = await getForegroundApp(); } catch (e) { logCrash('getForegroundApp', e); }
  const app = fg ? String(fg.process || '').toLowerCase().replace(/\.exe$/, '') : '';
  if (!app) { fgReminderApp = ''; fgReminderSince = 0; return; }
  const now = Date.now();
  if (app !== fgReminderApp) { fgReminderApp = app; fgReminderSince = now; return; }
  const elapsedMin = (now - fgReminderSince) / 60000;
  if (elapsedMin < cfg.reminderAfterMin) return;
  const list = cfg.reminderApps || [];
  if (list.length > 0 && !list.some((x) => app.includes(String(x).toLowerCase()))) return;
  const last = fgReminderLast[app] || 0;
  if (now - last < cfg.reminderCooldownMin * 60000) return;
  fgReminderLast[app] = now;
  fireReminder(app, fg ? fg.title : '', Math.floor(elapsedMin));
}

function startReminderPoll() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(() => {
    pollReminder().catch((e) => logCrash('pollReminder', e));
  }, 15000);
}
function stopReminderPoll() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}

async function doCapture(passedFg) {
  if (busy) {
    send('log', { level: 'warn', msg: '上一轮分析尚未完成，跳过本次截屏' });
    return;
  }
  busy = true;
  const started = Date.now();
  const now = new Date();

  try {
    // 按需取前台窗口（事件驱动时已传入，避免重复 PowerShell 调用）
    let fg = passedFg || null;
    const needFg = (cfg.privacyExclude && cfg.privacyExclude.enabled) || cfg.titleFirstAnalysis;
    if (!fg && needFg) {
      try { fg = await getForegroundApp(); } catch (e) { logCrash('getForegroundApp', e); }
    }
    // —— 自愈：离线时省截屏与分析，仅周期性探测恢复 ——
    if (!ollamaOnline) {
      offlineProbeTick++;
      if (offlineProbeTick >= 10) {
        offlineProbeTick = 0;
        const st = await analyzer.checkOllama(cfg.ollamaBaseUrl, cfg.model);
        if (st.ok && st.modelInstalled) {
          ollamaOnline = true;
          ollamaLoggedOffline = false;
          send('log', { level: 'info', msg: 'Ollama 已恢复，分析继续' });
        }
      }
      return; // finally 会释放 busy
    }

    // —— 空闲 / 锁屏暂停：不烧 AI 在无活动的画面上 ——
    if (screenLocked) return;
    if (typeof powerMonitor.getSystemIdleTime === 'function') {
      // ponytail: getSystemIdleTime 返回秒；超过阈值即视为无活动，静默跳过（连截屏都省）
      if (powerMonitor.getSystemIdleTime() >= cfg.idleThresholdSec) return;
    }

    // —— 隐私排除 / 模糊：命中名单则跳过，或仅存一张模糊缩略图（不调 AI）——
    if (cfg.privacyExclude && cfg.privacyExclude.enabled) {
      if (!fg) { try { fg = await getForegroundApp(); } catch (e) { logCrash('getForegroundApp', e); } }
      if (fg && isExcluded(fg, cfg.privacyExclude)) {
        if (cfg.privacyExclude.mode === 'blur') {
          const shot = await captureScreenshot({
            quality: cfg.screenshotQuality,
            maxWidth: cfg.screenshotMaxWidth,
            tinyWidth: cfg.privacyExclude.blurWidth || 360,
          });
          // 模糊帧去重：屏幕未变则跳过
          const tinyHash = crypto.createHash('md5').update(shot.tinyBuffer).digest('hex');
          if (tinyHash === lastFrameHash) return;
          lastFrameHash = tinyHash;
          const imagePath = storage.saveScreenshot(shot.tinyBuffer, cfg.dataDir, now, shot.ext);
          if (imagePath) send('screenshot', { imagePath, timestamp: now.toISOString(), privacy: 'blurred' });
          const record = {
            timestamp: now.toISOString(),
            imagePath,
            model: cfg.model,
            activity: '[隐私窗口，已模糊处理，未做内容识别]',
            sentences: [],
            analysisStatus: 'ok',
            error: null,
            privacy: 'blurred',
          };
          await storage.appendRecord(cfg.dataDir, now, record);
          send('record', record);
          return; // finally 释放 busy
        }
        // 排除模式：整帧跳过，仅记一条红标
        const record = {
          timestamp: now.toISOString(),
          imagePath: '',
          model: cfg.model,
          activity: '[隐私窗口，已自动排除，未记录画面]',
          sentences: [],
          analysisStatus: 'ok',
          error: null,
          privacy: 'excluded',
        };
        await storage.appendRecord(cfg.dataDir, now, record);
        send('record', record);
        send('log', { level: 'info', msg: `隐私排除：${fg.process} - ${fg.title}` });
        return; // finally 释放 busy
      }
    }

    const shot = await captureScreenshot({
      quality: cfg.screenshotQuality,
      maxWidth: cfg.screenshotMaxWidth,
    });

    // —— 帧去重：屏幕未变则整轮跳过（最贵的 AI 分析省了）——
    // ponytail: 基于 JPEG 字节相等判定；亚像素抖动可能漏判，必要时改感知哈希
    const frameHash = crypto.createHash('md5').update(shot.buffer).digest('hex');
    if (frameHash === lastFrameHash) return; // 静默跳过
    lastFrameHash = frameHash;
    lastCaptureAt = Date.now(); // 标记“本次真正截到了”，供同窗口 5 分钟节流使用

    let imagePath = '';
    if (cfg.storeScreenshots) {
      if (cfg.keepRepresentativeOnly) {
        const bucketId = summary.bucketId(now);
        if (repFrameByBucket.has(bucketId)) {
          // 非代表帧：仅分析，不落盘；imagePath 指向本桶代表帧
          imagePath = repFrameByBucket.get(bucketId);
        } else {
          // 桶的首帧：落盘作为代表帧
          imagePath = storage.saveScreenshot(shot.buffer, cfg.dataDir, now, shot.ext);
          repFrameByBucket.set(bucketId, imagePath);
          if (repFrameByBucket.size > 3000) repFrameByBucket.clear(); // 极长期运行的兜底
        }
      } else {
        imagePath = storage.saveScreenshot(shot.buffer, cfg.dataDir, now, shot.ext);
      }
    }

    if (imagePath) send('screenshot', { imagePath, timestamp: now.toISOString() });

    let activity = '';
    let sentences = [];
    let status = 'ok';
    let error = null;

    // —— 分层分析：标题已充分描述活动（且非浏览器/媒体/图像类）时，跳过昂贵的多模态模型 ——
    if (cfg.titleFirstAnalysis && fg && shouldSkipModel(fg, cfg)) {
      activity = buildTitleActivity(fg);
      status = 'title-only';
      send('log', { level: 'debug', msg: `标题优先：跳过模型（${String(fg.process || '').replace(/\.exe$/i, '')}）` });
    } else {
      const base64 = shot.buffer.toString('base64');
      try {
        const text = await analyzer.analyzeImage(base64, cfg);
        activity = text.trim();
      } catch (e) {
        if (isConnError(e)) {
          // 自愈：离线，暂停分析、不写 error 记录（避免 JSON 膨胀），并启动周期探测
          ollamaOnline = false;
          offlineProbeTick = 0;
          if (!ollamaLoggedOffline) {
            ollamaLoggedOffline = true;
            send('log', { level: 'warn', msg: 'Ollama 离线，已暂停分析，恢复后自动继续' });
          }
          return; // finally 释放 busy；不写记录
        }
        status = 'error';
        error = e.message;
        send('log', { level: 'error', msg: `分析失败：${e.message}` });
      }
    }

    // 落库前防御性清洗：剥离任何解码残留的替换符（U+FFFD），确保乱码永不入库存
    activity = sanitize(activity);
    sentences = storage.splitSentences(activity);

    const record = {
      timestamp: now.toISOString(),
      imagePath,
      model: cfg.model,
      activity,
      sentences,
      analysisStatus: status,
      error,
    };
    await storage.appendRecord(cfg.dataDir, now, record);
    send('record', record);
  } catch (e) {
    send('log', { level: 'error', msg: `截屏失败：${e.message}` });
  } finally {
    busy = false;
    lastTickDuration = Date.now() - started;
    send('stats', { lastTickMs: lastTickDuration, running, busy, ollamaOnline });
  }
}

function start() {
  if (running) {
    send('log', { level: 'info', msg: '已在运行中，无需重复开始' });
    return;
  }
  running = true;
  lastFrameHash = null; // 重启采集时强制首帧分析，避免沿用停止前的旧指纹
  lastTickDuration = 0;
  lastFgKey = null;
  lastCaptureAt = 0;
  lastSwitchAt = 0;
  send('status', { running });
  if (cfg.triggerMode === 'interval') {
    send('log', { level: 'info', msg: `已开始：每 ${cfg.captureIntervalMs / 1000}s 截屏一次（固定间隔）` });
  } else {
    send('log', { level: 'info', msg: '已开始（事件驱动：窗口切换即截 / 同窗口每5分钟补截 / 离开电脑暂停）' });
  }
  doCapture(null).finally(scheduleNext);
}

// 排程：事件驱动用轻量前台轮询决定何时截屏；interval 模式退化为固定间隔（兜底）
function scheduleNext() {
  if (!running) return;
  if (cfg.triggerMode === 'interval') {
    const spacing = Math.max(cfg.captureIntervalMs, lastTickDuration + INTERVAL_GAP_MS);
    const delay = Math.max(0, spacing - lastTickDuration);
    timer = setTimeout(() => { doCapture(null).finally(scheduleNext); }, delay);
    return;
  }
  timer = setTimeout(pollAndMaybeCapture, cfg.fgPollMs);
}

// 事件驱动核心：轻量轮询前台窗口，按“切换 / 长时间停留 / 空闲”三类规则决定是否真正截屏
async function pollAndMaybeCapture() {
  if (!running) return;
  // 空闲：不烧截屏；保持轻量轮询以检测“回到电脑”
  if (typeof powerMonitor.getSystemIdleTime === 'function' &&
      powerMonitor.getSystemIdleTime() >= cfg.idleThresholdSec) {
    lastFgKey = null; // 回来时强制按“切换”触发一次补截
    scheduleNext();
    return;
  }
  let fg = null;
  try { fg = await getForegroundApp(); } catch (e) { /* 忽略，下一轮再试 */ }
  const key = fg ? (fg.process + '|' + fg.title) : null;
  const now = Date.now();
  if (key && key !== lastFgKey) {
    // 窗口切换：等画面加载稳定后再截（默认 10s）
    lastFgKey = key;
    lastSwitchAt = now;
    const wait = Math.max(0, cfg.windowSwitchDelayMs - (now - lastCaptureAt));
    timer = setTimeout(() => { doCapture(fg).finally(scheduleNext); }, wait);
    return;
  }
  if (key && key === lastFgKey) {
    // 同窗口停留：最多每 sameWindowMaxMs 补截一张，避免长文档编辑时完全失记
    if (now - lastCaptureAt >= cfg.sameWindowMaxMs) {
      timer = setTimeout(() => { doCapture(fg).finally(scheduleNext); }, 0);
      return;
    }
  }
  scheduleNext();
}

function stop() {
  if (!running) return;
  running = false;
  if (timer) clearTimeout(timer); // 打断自调度链；in-flight tick 的 finally 会因 running=false 不再续排
  timer = null;
  send('status', { running });
  send('log', { level: 'info', msg: '已停止（汇总队列仍会在退出前继续处理）' });
}

// ---------- IPC ----------
ipcMain.handle('start', async () => {
  start();
  return { running };
});

ipcMain.handle('stop', async () => {
  stop();
  return { running };
});

ipcMain.handle('getConfig', async () => cfg);
ipcMain.handle('getState', async () => ({ running }));

ipcMain.handle('updateConfig', async (_e, partial) => {
  const saved = config.saveConfig(partial || {});
  cfg = { ...cfg, ...saved };
  const reschedKeys = ['captureIntervalMs', 'triggerMode', 'fgPollMs', 'windowSwitchDelayMs', 'sameWindowMaxMs', 'idleThresholdSec', 'titleFirstAnalysis', 'privacyExclude'];
  if (running && partial && reschedKeys.some((k) => k in partial)) {
    if (timer) clearTimeout(timer);
    scheduleNext(); // 用新策略重新排程（进行中的 doCapture 会在 finally 重新挂接）
  }
  if ('summaryIntervalMin' in partial) {
    startSummaryScheduler(); // 热更新汇总节奏
  }
  return cfg;
});

ipcMain.handle('checkOllama', async () => analyzer.checkOllama(cfg.ollamaBaseUrl, cfg.model));

// 存储占用与空间预警信息（供 UI 展示“还能撑多久”）
ipcMain.handle('getStorageInfo', async () => {
  const usage = storage.storageUsage(cfg.dataDir);
  const freeBytes = storage.diskFreeBytes(cfg.dataDir);
  // 近 1 小时截图增量；若不足 1 小时数据，退化为把现有总量当 1 天估算（仅用于粗略预警）
  const hourlyRateBytes =
    usage.hourlyRateBytes > 0
      ? usage.hourlyRateBytes
      : usage.screenshotCount > 0
        ? usage.screenshotsBytes
        : 0;
  const dailyProjectedBytes = hourlyRateBytes * 24;
  const retentionDays = cfg.screenshotRetentionDays || 0;
  // 保留策略下的稳态上限（截图维度）：每天增量 × 保留天数；代表帧模式实际更低，取保守上界
  const retentionCapBytes = retentionDays > 0 ? dailyProjectedBytes * retentionDays : null;
  const nonScreenshotBytes = Math.max(0, usage.totalBytes - usage.screenshotsBytes);
  const projectedTotalAtCap =
    retentionCapBytes != null ? nonScreenshotBytes + retentionCapBytes : null;
  let status = 'safe';
  let daysLeft = null;
  if (freeBytes != null) {
    daysLeft = dailyProjectedBytes > 0 ? freeBytes / dailyProjectedBytes : null;
    // 即便受保留约束，若稳态上限仍超过剩余空间则预警
    if (projectedTotalAtCap != null && projectedTotalAtCap > freeBytes) status = 'warn';
  }
  const archive = storage.archiveInfo(cfg.dataDir);
  return {
    ...usage,
    freeBytes,
    retentionDays,
    keepRepresentativeOnly: !!cfg.keepRepresentativeOnly,
    dailyProjectedBytes,
    retentionCapBytes,
    projectedTotalAtCap,
    status,
    daysLeft,
    archive,
  };
});

// 归档区间查询（远期回看 / 导出）：opts = { from, to }（ISO 或 Date）
ipcMain.handle('getArchive', async (_e, opts) => {
  const { from, to } = opts || {};
  return storage.getArchiveRecords(cfg.dataDir, from, to);
});

// 动态页：热力图 / 时间线 / 桶详情 / 筛选选项 / 汇总状态
ipcMain.handle('getHeatmap', async (_e, opts) => summary.getHeatmap(cfg.dataDir, opts || {}));
ipcMain.handle('getTimeline', async (_e, opts) => summary.querySummaries(cfg.dataDir, opts || {}));
ipcMain.handle('getBucketDetail', async (_e, bucketId) =>
  summary.getBucketDetail(cfg.dataDir, bucketId)
);
ipcMain.handle('getFilterOptions', async (_e, opts) =>
  summary.getFilterOptions(cfg.dataDir, opts || {})
);
ipcMain.handle('getSummaryStatus', async () => ({
  summarizing,
  queueLength: summaryQueue.length,
}));

// 日记页：读取某天日记；若不存在且当天有汇总则触发生成
ipcMain.handle('getDiary', async (_e, date) => {
  const existing = diary.loadDayDiary(cfg.dataDir, date);
  if (existing) return { status: 'ok', diary: existing };
  const sums = summary.loadDaySummaries(cfg.dataDir, date);
  const hasOk = Object.keys(sums).some((b) => sums[b].status === 'ok');
  if (hasOk) {
    enqueueDiary(date);
    return { status: 'pending' };
  }
  return { status: 'empty' };
});

ipcMain.handle('requestDiary', async (_e, date) => {
  const sums = summary.loadDaySummaries(cfg.dataDir, date);
  const hasOk = Object.keys(sums).some((b) => sums[b].status === 'ok');
  if (!hasOk) return { status: 'empty' };
  enqueueDiary(date);
  return { status: 'pending' };
});

ipcMain.handle('getDiaryStatus', async () => ({
  diarying,
  queueLength: diaryQueue.length,
}));

// 打开日记页时：扫描并排队所有未生成日记的日期
ipcMain.handle('scanDiaryBacklog', async () => {
  const missing = diary.collectDiaryBacklog(cfg.dataDir);
  missing.forEach((d) => enqueueDiary(d));
  return { queued: missing.length };
});

ipcMain.handle('getMonthMarkers', async (_e, { year, month }) => {
  const a = diary.getMonthMarkers(cfg.dataDir, year, month);
  const b = notes.getMonthNoteMarkers(cfg.dataDir, year, month);
  const merged = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    merged[k] = { ...(a[k] || {}), ...(b[k] || {}) };
  }
  return merged;
});

// ---------- 手动日记（随笔/随手记）----------
// 读取某天手动笔记（无则返回 null）
ipcMain.handle('getNote', async (_e, date) => {
  const note = notes.loadDayNote(cfg.dataDir, date);
  return note;
});

// 保存某天手动笔记：空内容则删除（连同图片）；非空则原子写入并清理孤儿图片
ipcMain.handle('saveNote', async (_e, { date, html, text, tags }) => {
  const empty =
    (!text || !String(text).trim()) &&
    (!html || !String(html).replace(/<[^>]*>/g, '').trim());
  if (empty) {
    notes.deleteDayNote(cfg.dataDir, date);
    return { ok: true, deleted: true };
  }
  const old = notes.loadDayNote(cfg.dataDir, date);
  const oldImgs = (old && Array.isArray(old.images)) ? old.images : [];
  const newImgs = notes.referencedImages(cfg.dataDir, html);
  // 删除不再被引用的孤儿图片
  for (const rel of oldImgs) {
    if (!newImgs.includes(rel)) {
      try {
        fs.unlinkSync(path.join(cfg.dataDir, rel));
      } catch (_) {
        /* ignore */
      }
    }
  }
  notes.saveDayNote(cfg.dataDir, {
    date,
    html: html || '',
    text: text || '',
    tags: Array.isArray(tags) ? tags : [],
    images: newImgs,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, deleted: false };
});

// 保存一张笔记图片（buf 为字节数组），返回 { rel, url }
ipcMain.handle('saveNoteImage', async (_e, { date, ext, buf }) => {
  const buffer = Buffer.from(buf);
  return notes.saveNoteImage(cfg.dataDir, date, ext, buffer);
});

// 列出全部标签（含出现天数与日期列表，供标签云/筛选）
ipcMain.handle('getNoteTags', async () => notes.getAllTags(cfg.dataDir));

// 看板页：按 day/week/month/year 聚合数据
ipcMain.handle('getDashboard', async (_e, { type, value }) =>
  analytics.getDashboard(cfg.dataDir, type, value)
);

// 问答页：agentic 检索增强问答（最多 3 轮 plan+search，再基于上下文作答）
ipcMain.handle('askQuestion', async (_e, question) => {
  if (!question || !String(question).trim()) {
    return { steps: [], collectedCount: 0, answer: '请输入一个问题。' };
  }
  return qa.askQuestion(cfg, String(question).trim());
});

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    icon: getAppIcon(),
    show: !startHidden, // 开机自启(--hidden)时不闪现窗口，直接驻留托盘
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const loadPath = path.join(__dirname, 'renderer', 'index.html');
  mainWindow.loadFile(loadPath);
  // mainWindow.webContents.openDevTools();

  // 窗口加载完成后再同步一次运行状态（自动启动时 start() 发出的 status 可能早于渲染进程注册监听而丢失）
  mainWindow.webContents.on('did-finish-load', () => {
    send('status', { running });
  });

  // 关窗 = 最小化到托盘（除非点了“退出”）；记录仪本就该常驻后台
  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
    mainWindow = null;
  });
}

// 显示主界面（托盘菜单 / 双击托盘调用）
function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ===== 桌面快捷方式（用本机 COM 生成，避开手写二进制 lnk 的坑）=====
// PowerShell 单引号转义：' -> ''
function psStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// 自启 / 快捷方式 一律指向「固定的安装路径」，而不是 process.execPath。
// 原因：dist\LifeLens.exe 是 portable 自解压壳，运行时真实程序被解压到 %TEMP%\xxx\ 下，
// process.execPath 指向的是那个随机临时目录 → 若把 Temp 路径写进注册表自启 / 桌面 lnk，
// 开机时 Windows 会去启动已失效的临时 exe → 弹窗报错（用户实际遇到的「开机一直弹 cmd」）。
// electron-builder portable 会注入 PORTABLE_EXECUTABLE_DIR = <安装目录>/dist，直接拼 exe 名即固定真身。
function resolveSelfPath() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (dir) {
    return path.join(dir, 'LifeLens.exe');
  }
  return process.execPath;
}

// 调本机 powershell 的 WScript.Shell 生成正规 .lnk（force=true 时即使已存在也重建）
function buildDesktopShortcut(force, cb) {
  let desktop;
  try {
    desktop = app.getPath('desktop');
  } catch (e) {
    desktop = path.join(os.homedir(), 'Desktop');
  }
  const lnkPath = path.join(desktop, 'LifeLens.lnk');
  if (!force && fs.existsSync(lnkPath)) {
    if (cb) cb(null, 'exists');
    return;
  }
  const target = resolveSelfPath();
  const ps =
    '$ws = New-Object -ComObject WScript.Shell;' +
    '$lnk = $ws.CreateShortcut(' + psStr(lnkPath) + ');' +
    '$lnk.TargetPath = ' + psStr(target) + ';' +
    '$lnk.WorkingDirectory = ' + psStr(path.dirname(target)) + ';' +
    '$lnk.Description = "LifeLens 时间记录器";' +
    '$lnk.IconLocation = ' + psStr(target + ',0') + ';' +
    '$lnk.Save();';
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => {
    if (cb) cb(err);
  });
}

// 创建系统托盘：常驻后台 + 右键菜单（显示 / 退出）
function createTray() {
  if (tray) return;
  const icon = getAppIcon();
  tray = new Tray(icon);
  tray.setToolTip('LifeLens（双击打开）');
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: resolveSelfPath(), args: ['--hidden'] });
        // 持久化：否则下次启动 whenReady 会按 cfg.autoStartCapture 重置该开关
        cfg.autoStartCapture = item.checked;
        config.saveConfig({ autoStartCapture: item.checked });
      },
    },
    {
      label: '创建桌面快捷方式',
      click: () => {
        buildDesktopShortcut(true, (err) => {
          if (err) {
            dialog.showErrorBox('创建快捷方式失败', '请手动右键 LifeLens.exe → 发送到 → 桌面快捷方式。\n' + err.message);
          } else if (mainWindow) {
            dialog.showMessageBox(mainWindow, { type: 'info', title: 'LifeLens', message: '已创建/刷新桌面快捷方式 LifeLens.lnk。' });
          }
        });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showWindow());
  tray.on('click', () => showWindow()); // Windows 单击托盘图标也打开
}

app.whenReady().then(() => {
  // 打包后依配置注册开机自启（托盘菜单可切换）；--hidden 让开机后台驻留托盘、不闪窗口
  // 开发模式不注册，避免把 electron 写进启动项。配置 autoStartCapture:false 时主动注销
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: !!cfg.autoStartCapture,
      path: resolveSelfPath(),
      args: ['--hidden']
    });
  }
  ensureOllama(); // 自管 Ollama：不可达则无界面拉起 serve（不依赖桌面 GUI）
  createWindow();
  createTray(); // 托盘常驻（后台记录仪）

  // 首次运行（且桌面尚无 LifeLens.lnk）自动在本机生成正规桌面快捷方式，
  // 用本机 COM 而非手写二进制，确保"双击桌面图标即可打开"长期可靠
  if (app.isPackaged) {
    buildDesktopShortcut(false, () => {});
  }

  // —— 空闲 / 锁屏暂停：事件驱动，挂起/锁屏即停，恢复即续 ——
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
    send('log', { level: 'warn', msg: '屏幕已锁定，暂停采集' });
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    send('log', { level: 'info', msg: '屏幕已解锁，恢复采集' });
  });
  powerMonitor.on('suspend', () => {
    screenLocked = true;
    send('log', { level: 'warn', msg: '系统挂起，暂停采集' });
  });
  powerMonitor.on('resume', () => {
    screenLocked = false;
    send('log', { level: 'info', msg: '系统恢复，恢复采集' });
  });

  // 启动汇总调度 + backlog 扫描（与截屏录制相互独立）
  startSummaryScheduler();
  runBacklogScan();
  pushSummaryStatus();

  // 旧截图保留清理（启动即清历史堆积，之后每小时一次）
  startRetentionCleaner();

  // 日记（二阶汇总）backlog 扫描
  runDiaryBacklogScan();
  pushDiaryStatus();

  // 持续活动提醒：独立于截屏，开机即生效（锁屏/空闲不计时，命中名单才提醒）
  app.setAppUserModelId('com.lifelens.app');
  startReminderPoll();

  // 开机/启动即自动开始截屏（无需手动按「开始」）；settings.json 置 autoStartCapture:false 可关闭
  if (cfg.autoStartCapture) start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  // 已有实例被再次启动时（如双击快捷方式），直接唤起主界面
  app.on('second-instance', () => showWindow());
});

// 托盘模式下：窗口全关也不退出（托盘保活）；只有“退出”菜单置 isQuiting 才真退
app.on('window-all-closed', () => {
  stop();
  if (isQuiting) app.quit();
});

app.on('before-quit', () => {
  isQuiting = true;
  stop();
  if (summaryTimer) clearInterval(summaryTimer);
  if (reminderTimer) clearInterval(reminderTimer);
});

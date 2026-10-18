'use strict';

const fs = require('fs');
const path = require('path');

// 默认配置
const DEFAULTS = {
  // 截屏间隔（毫秒）。触发模式为 'interval'（固定轮询）时生效，作为兜底/兼容
  captureIntervalMs: 20 * 1000,
  // 空闲暂停阈值（秒）：系统空闲超过该时长则暂停采集，回到电脑即恢复（建议 180 = 3 分钟）
  idleThresholdSec: 120,

  // ===== 截屏触发模式（性能关键）=====
  // 'event'  = 事件驱动（推荐，默认）：仅在前台窗口切换 / 同窗口停留超 5 分钟时截屏，离开电脑则暂停；
  //            一天仅几十~一两百次，风扇不再狂转。'interval' = 旧版固定间隔轮询（兜底）。
  triggerMode: 'event',
  // 前台窗口轮询间隔（ms）：仅轻量读取当前窗口，不截屏；用它来“感知切换”
  fgPollMs: 2500,
  // 窗口切换后延迟（ms）：等页面/内容加载稳定再截，避免截到空白
  windowSwitchDelayMs: 10000,
  // 同一窗口最长停留多久才补截一张（ms）：避免长时间编辑文档时完全失记，又不必 20s 一次
  sameWindowMaxMs: 5 * 60 * 1000,

  // 应用启动（含开机自启）时是否自动开始截屏；false=启动后仍需手动按「开始」
  autoStartCapture: true,

  // 本地 Ollama 服务地址
  ollamaBaseUrl: 'http://127.0.0.1:11434',

  // 本地视觉模型（用户指定 qwen3-vl 4b instruct）
  // 若拉取标签不同可改为 'qwen3-vl:4b'
  model: 'qwen3-vl:4b-instruct',

  // ===== 资源占用策略（解决「开着 LifeLens 时跑不动自己的 AI 项目」）=====
  // analysisGpuMode:
  //   'cpu'（默认）—— 强制模型推理走 CPU（num_gpu_layers=0），完全不占 GPU 显存，
  //                    把整张显卡让给你的 AI 训练/推理；代价是单条分析稍慢（后台记录，可接受）。
  //   'gpu'        —— 让 Ollama 自行决定（默认占满显卡，速度快，但会和你其它 AI 任务抢卡）。
  // 只在「你确定不同时跑其它 AI」时切到 'gpu'。
  analysisGpuMode: 'cpu',
  // CPU 推理使用的线程数；0 = 自动取物理核心的一半（为其它程序留余量）。若想更激进可手动设大。
  cpuThreads: 0,

  // 数据根目录：按月建文件夹、按小时建 JSON 文件都在此之下
  dataDir: path.join(__dirname, 'data'),

  // ===== 截屏存储（省空间关键）=====
  // 保存格式：jpeg（有损，对模型识别无影响，比 png 小很多）。可改为 'png'。
  screenshotFormat: 'jpeg',
  // JPEG 质量 0-100（界面可配，默认 70：文本/界面截图压缩比极高）
  screenshotQuality: 70,
  // 截屏最大宽度（px）：超过则等比缩小，模型识别 UI 绰绰有余；0 = 不缩放（原分辨率）
  screenshotMaxWidth: 1600,
  // 旧截图保留天数（界面可配）：超过该天数的截图文件自动删除；0 = 永久保留
  screenshotRetentionDays: 7,
  // 仅保留“代表帧”：每 10 分钟只落盘一张代表截图，其余 20s 帧分析完即弃，绝不写盘（再省 ~6 倍）
  keepRepresentativeOnly: true,

  // ===== 文本记录归档（着重设计）=====
  // LIVE 窗口：最近 N 天内的月份保留完整小时 JSON（含文本+图片路径）；0 = 永不归档
  // 超出窗口的整月 → 抽文本写 archive/<YYYY-MM>.json，并删除原始小时 JSON（最大头空间释放）
  textRetentionDays: 30,
  // 归档文件冷保留：超过该天数的 archive 文件删除；0 = 永久保留
  maxArchiveAgeDays: 0,

  // ===== 隐私排除 / 模糊 =====
  // enabled: 总开关；mode: 'exclude'(整帧跳过，仅记一条红标) | 'blur'(存一张降分辨率缩略图，不调 AI)
  // apps: 前台进程名子串（小写，如 'password' 'bank' 'chrome'）；titles: 窗口标题子串（如 '银行' '网银'）
  privacyExclude: {
    // 默认开启：金融 / 密码类窗口直接跳过，连标题都不记录（隐私底线）
    // 注：微信/WhatsApp/Telegram 等聊天软件默认“未”加入——LifeLens 本就记录社交活动；
    //     若你也想排除聊天，把对应词加进 titles/apps 即可。
    enabled: true,
    mode: 'exclude',
    apps: ['password', 'bank', 'keychain', '1password', 'lastpass', 'wallet', 'alipay'],
    titles: ['银行', '支付宝', '网银', '证券', '交易', '密码', 'keychain', '1password', 'lastpass', '私密', 'private'],
    blurWidth: 360,
  },

  // ===== 隐私 / 省资源 总开关 =====
  // storeScreenshots: false = 永不把截图写磁盘（仅保留文字描述），满足“绝对不留痕”诉求；
  //   默认 true，因为 LifeLens 本质是视觉生活日志，动态页/日记都依赖截图回忆。按需关闭即可。
  storeScreenshots: true,
  // 分层分析：标题已充分描述活动时（且非浏览器/媒体/图像类），跳过昂贵的 GPU 多模态模型
  titleFirstAnalysis: true,
  // 这些应用“画面以图像/视频/游戏为主”，窗口标题通常不足以描述内容 → 始终调用模型。
  // 注意：浏览器 / 聊天软件已从「始终模型」移除 —— 它们的标题（文件名/网页标题/对话对象）通常
  // 已足够描述活动，交由「标题优先」零成本分类即可，避免无谓地占用算力（借鉴 ActivityWatch 规则分类思路）。
  titleAlwaysModelApps: [
    'photoshop', 'photoviewer', 'photos', 'paint', 'gimp', 'krita',
    'potplayer', 'vlc', 'mpv', 'kmplayer', 'iqiyi', 'youku', 'tencentvideo', 'bilibili', 'pptv',
    'steam', 'epicgameslauncher', 'battlenet',
  ],

  // ===== 持续活动提醒（防沉迷 / 正念）=====
  // enabled: 总开关；afterMin: 同一应用连续多久后提醒（分钟）；cooldownMin: 同应用两次提醒最小间隔；
  // apps: 仅对这些应用提醒（进程名小写子串），空数组 = 任何应用都提醒。默认聚焦休闲类（游戏/浏览器/视频）。
  reminderEnabled: true,
  reminderAfterMin: 60,
  reminderCooldownMin: 30,
  reminderApps: [
    'steam', 'epicgameslauncher', 'battlenet', 'xbox', 'origin', 'galaxyclient',
    'ubisoftconnect', 'roblox', 'minecraft', 'leagueclient',
    'chrome', 'msedge', 'brave', 'firefox', 'opera',
    'iqiyi', 'youku', 'tencentvideo', 'potplayer', 'vlc', 'mpv', 'bilibili',
  ],

  // 系统提示：约束模型角色与语言 + 强反幻觉
  systemPrompt:
    '你是一个专注、客观的用户行为观察助手。请用简洁的中文描述用户在屏幕上的活动。\n' +
    '核心原则——零幻觉：\n' +
    '- 只描述截图中明确可见的内容（窗口标题、按钮文字、页面文字、图标等）；\n' +
    '- 绝对禁止编造或猜测截图中不存在的信息；\n' +
    '- 如果看不清或不确定，直接说"无法识别"，不要用模糊推测替代；\n' +
    '- 影视/游戏/直播等：除非截图中出现清晰可读的标题文字（字幕、文件名、播放器或网页标题栏、UI 文字），否则严禁给出具体片名/游戏名——只能用"观看视频""在玩游戏"等泛称；绝不许凭画面风格、人物长相、海报观感去猜测具体名称。\n' +
    '- 不评价、不推测动机、不加任何主观解读。',

  // 用户提示：要求输出简短的 5 句话总结
  prompt:
    '请仔细观察这张截图，用简短的 5 句话总结用户当前正在做什么。\n' +
    '要求：\n' +
    '1. 每句话只描述截图中**实际可见**的内容（软件名称取自窗口标题栏/任务栏、网页内容取自页面文字、文件名取自标题）；\n' +
    '2. 只输出 5 句话，不要编号、不要标题、不要问候语或额外解释；\n' +
    '3. 若画面信息不足，用一句话说明"画面信息不足，无法判断"，其余句子省略；\n' +
    '4. 【重要】严禁编造截图里没有的应用名称、影视名、游戏名或其他内容。\n' +
    '5. 【关键·媒体命名】若画面是影视/游戏/直播，必须能在截图中看到可读的标题文字（字幕、文件名、播放器/网页标题栏）才允许写出具体名称；若看不到明确标题，只写"在观看视频""在玩游戏"等泛称，绝不许凭画面观感猜片名。',

  // 单次分析超时（毫秒）
  analysisTimeoutMs: 90 * 1000,

  // 视觉分析温度：0 = 完全确定性输出，最大程度抑制 qwen3-vl:4b 这类小模型凭"画面风格"脑补片名/游戏名。
  // 之前写死 0.3，随机性会让模型更敢编造具体名称；降到 0 后输出更稳定、更少幻觉。
  analysisTemperature: 0.8,
  // 严格媒体命名二次校验：开启后，若模型给出了《片名》但截图中没有可读标题文字佐证，
  // 自动把《片名》降级为"媒体内容"（防《繁花》式误标）。代价：每个截图多一次 Ollama 调用。默认关闭。
  strictMediaNaming: false,

  // ===== 十分钟汇总相关 =====
  // 汇总间隔（分钟）：每 10 分钟汇总一次
  summaryIntervalMin: 10,

  // 单次汇总（含 ~1000 字描述生成）超时（毫秒）
  summaryTimeoutMs: 120 * 1000,

  // 单次日记（二阶汇总）超时（毫秒）
  diaryTimeoutMs: 150 * 1000,

  // 热力图默认显示最近多少小时（每个点 = 10 分钟）
  heatmapHours: 24,

  // ===== 日记（二阶汇总）相关 =====
  // 日记系统提示
  diarySystemPrompt:
    '你是一个温暖的“个人每日生活日记官”。你会收到某一天里所有 10 分钟窗口的结构化活动汇总' +
    '（每个窗口含项目名、分类、详细描述、用到的软件、可能的待办）。请综合全天信息，' +
    '以第一人称、像写日记一样，输出严格合法的 JSON 对象，不要包含任何额外文字、解释或代码块标记（如 ```json）。',

  // 日记用户提示（{{DATE}} 会被日期替换，{{SUMMARIES}} 会被全天各窗口汇总替换）
  diaryUserPrompt:
    '请基于下面这一整天的所有 10 分钟活动汇总，写一份“当日日记”。\n' +
    '日期：{{DATE}}\n' +
    '字段要求：\n' +
    '1. brief：简短总结（2-4 句话），概括这一天的主旋律与整体状态。\n' +
    '2. mainItems：主要事项——这一天做的“三件”最重要的事情（字符串数组，恰好 3 条，每条一句话）。\n' +
    '3. highlights：高光时刻——值得记住的开心、有成就或有趣的瞬间（字符串数组，2-5 条）。\n' +
    '4. todos：待办——从当天遗漏待办与未完成事项中梳理出的、值得之后跟进的事项（字符串数组，可空）。\n' +
    '5. suggestions：优化建议——基于这一天的时间分配与使用习惯，给出的 1-3 条可行改进建议（字符串数组）。\n' +
    '6. tips：温馨提示——一句关怀式的小提醒（字符串，如作息、喝水、护眼、运动等）。\n' +
    '只输出如下 JSON（不要 ``` 标记）：\n' +
    '{"brief":"...","mainItems":["...","...","..."],"highlights":["..."],"todos":["..."],"suggestions":["..."],"tips":"..."}\n\n' +
    '【当天各 10 分钟窗口汇总（按时间顺序，已截断）】\n{{SUMMARIES}}',

  // ===== 问答（agentic RAG）相关 =====
  // 单次问答（含 agentic 检索循环）超时（毫秒）
  qaTimeoutMs: 120 * 1000,

  // 规划阶段系统提示：让模型决定如何检索
  qaPlanSystemPrompt:
    '你是一个“个人活动记录检索助手”。用户的本地电脑上持续记录了三类活动数据：\n' +
    '1) record：每 20 秒一次的原始屏幕活动总结（5 句话）；\n' +
    '2) summary：每 10 分钟一次的结构化汇总（含项目名 project、分类 category、详细描述 description、软件列表 software）；\n' +
    '3) diary：每日二阶日记（含 brief 简短总结、主要事项、高光、待办等）。\n' +
    '你需要帮用户决定“如何检索”才能回答他的问题。请输出严格合法的 JSON，不要包含额外文字或代码块标记。',

  // 规划阶段用户提示（{{QUESTION}} 问题 / {{CONTEXT}} 已检索片段摘要）
  qaPlanUserPrompt:
    '用户问题：{{QUESTION}}\n' +
    '{{CONTEXT}}\n' +
    '请决定检索方式以回答这个问题。最多指定 3 个检索查询，每个包含：\n' +
    'source（只能是 "record" / "summary" / "diary" 之一）；\n' +
    'from 与 to（日期 YYYY-MM-DD，限定检索时间范围，尽量小以节省资源，跨度不要超过 30 天）；\n' +
    'keywords（3-6 个中文关键词，用于在对应数据中匹配相关片段）。\n' +
    '如果你认为现有检索结果已足够回答，设 done 为 true 且 queries 为空数组。\n' +
    '只输出如下 JSON：\n' +
    '{"queries":[{"source":"summary","from":"2026-07-20","to":"2026-07-29","keywords":["LifeLens","开发"]}],"done":false}\n' +
    '注意：若问题未指明时间，默认检索最近两周（from/to 取最近 14 天）。\n' +
    '特别说明：如果用户问的是开放式回顾问题（如“我最近在干什么”“今天做了什么”' +
    '“总结一下这几天”），请不要返回空 queries 或 done:true 而不检索——直接返回一个覆盖最近时间的查询即可，' +
    'keywords 可以留空数组（空 keywords 表示拉取该时间范围内的全部内容，用于整体回顾），' +
    '不要因为缺少具体关键词就放弃检索。',

  // 回答阶段系统提示
  qaAnswerSystemPrompt:
    '你是一个基于用户本地活动记录的问答助手。请仅依据下面“检索到的相关片段”回答用户问题，' +
    '不要编造未出现在片段中的信息。若片段不足以回答，请坦诚说明“根据已有记录无法确认”，并可提示用户换关键词再问。' +
    '用自然、简洁的中文回答。',

  // 回答阶段用户提示（{{QUESTION}} 问题 / {{CONTEXT}} 检索片段）
  qaAnswerUserPrompt:
    '用户问题：{{QUESTION}}\n\n' +
    '【检索到的相关片段（按时间倒序，已去重）】\n{{CONTEXT}}\n\n' +
    '请基于以上片段回答用户问题。若片段为空或无关，请如实说明。',

  // 汇总系统提示
  summarySystemPrompt:
    '你是一个专业的"用户活动时间线分析师"。你会收到某一个 10 分钟窗口内的多次截屏分析' +
    '（每 20 秒一次，每次是简短的 5 句话），以及上一个 10 分钟窗口的结构化汇总。\n' +
    '核心原则——零幻觉：\n' +
    '- project、description、software 等所有字段必须严格基于收到的活动记录生成；\n' +
    '- 绝对禁止编造记录中未提及的应用名、影视名、游戏名、文件名或其他具体内容；\n' +
    '- 如果记录信息模糊，用通用描述（如"使用某个应用程序"），不要猜测具体名称；\n' +
    '请综合这些信息，输出严格合法的 JSON 对象，不要包含任何额外文字、解释或代码块标记（如 ```json）。',

  // 汇总用户提示（{{PREV}} 会被上一个汇总替换，{{RECORDS}} 会被本窗口记录替换）
  summaryUserPrompt:
    '请基于下面这 10 分钟窗口内的所有截屏活动记录，生成结构化汇总。\n' +
    '字段要求：\n' +
    '1. project：用户正在做的"项目"名称，格式为"动作+对象"，如' +
    '"浏览网页""编辑文档""观看视频""编写代码""即时通讯"。' +
    '必须基于实际活动记录生成，严禁使用示例中的文字。' +
    '如果与上一个窗口的活动连续一致，必须使用完全相同的 project 名称（不要改写、不要加序号）。\n' +
    '2. category：从“娱乐/工作/学习/社交”中选且仅选一个。\n' +
    '3. description：约 1000 字的中文详细描述，覆盖这 10 分钟里用户做了什么、在哪些软件间切换、' +
    '看了/写了什么具体内容、节奏与状态如何等。\n' +
    '4. software：用到的软件/应用名称列表（字符串数组，去重）。\n' +
    '5. todos：可能遗漏的重要待办事项（字符串数组，没有则为空数组）。\n' +
    '只输出如下 JSON（不要 ``` 标记）：\n' +
    '{"project":"...","category":"娱乐|工作|学习|社交","description":"...","software":["..."],"todos":["..."]}\n\n' +
    '【上一个 10 分钟窗口汇总（仅供参考，保持 project 连续）】\n{{PREV}}\n\n' +
    '【本 10 分钟窗口活动记录（每行一次截屏总结）】\n{{RECORDS}}',
};

// settings.json 存放目录：开发/测试态默认在 __dirname（与源码同目录，可写）；
// 打包态（asar 只读）由 main.js 调用 setSettingsBase 重定向到 app.getPath('userData')。
let _settingsBase = __dirname;
function setSettingsBase(dir) {
  _settingsBase = dir;
}
function settingsPath() {
  return path.join(_settingsBase, 'settings.json');
}

// 合并：默认 + 已保存的用户设置（用户设置优先）
function loadConfig() {
  let merged = { ...DEFAULTS };
  try {
    if (fs.existsSync(settingsPath())) {
      const user = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      merged = { ...merged, ...user };
    }
  } catch (e) {
    // 配置文件损坏则忽略，回退默认
    console.warn('[config] 读取 settings.json 失败，使用默认配置：', e.message);
  }
  return merged;
}

// 仅持久化允许被 UI 修改的字段
const PERSISTABLE = [
  'captureIntervalMs',
  'autoStartCapture',
  'ollamaBaseUrl',
  'model',
  'dataDir',
  'screenshotQuality',
  'screenshotMaxWidth',
  'screenshotRetentionDays',
  'keepRepresentativeOnly',
  'textRetentionDays',
  'maxArchiveAgeDays',
  'privacyExclude',
  'idleThresholdSec',
  'triggerMode',
  'fgPollMs',
  'windowSwitchDelayMs',
  'sameWindowMaxMs',
  'storeScreenshots',
  'titleFirstAnalysis',
  'titleAlwaysModelApps',
  'reminderEnabled',
  'reminderAfterMin',
  'reminderCooldownMin',
  'reminderApps',
  'systemPrompt',
  'prompt',
  'analysisTimeoutMs',
  'analysisTemperature',
  'strictMediaNaming',
  'summaryIntervalMin',
  'summaryTimeoutMs',
  'heatmapHours',
  'diaryTimeoutMs',
  'diarySystemPrompt',
  'diaryUserPrompt',
];

function saveConfig(partial) {
  const clean = {};
  for (const key of PERSISTABLE) {
    if (key in partial && partial[key] !== undefined) {
      clean[key] = partial[key];
    }
  }
  let existing = {};
  try {
    if (fs.existsSync(settingsPath())) {
      existing = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    }
  } catch (_) {
    /* ignore */
  }
  const next = { ...existing, ...clean };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { DEFAULTS, loadConfig, saveConfig, setSettingsBase, settingsPath };

'use strict';

// 真实调用 Ollama 验证问答（agentic 检索 + 回答）端到端链路。
// 构造一份临时记录数据，验证检索能命中、回答能基于上下文产出。
// 需要本机 Ollama 已运行且安装 qwen3-vl:4b-instruct。

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const qa = require('../qa');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-e2e-qa-'));

// 写入一份覆盖最近两天的记录，确保检索有素材
for (const day of ['2026-07-28', '2026-07-29']) {
  fs.mkdirSync(path.join(tmp, '2026-07'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '2026-07', `${day}-10.json`),
    JSON.stringify({
      date: day,
      hour: 10,
      records: [
        { timestamp: `${day}T10:00:00+08:00`, activity: '用户在开发 LifeLens 项目，使用 VS Code 编写 Electron 主进程代码', sentences: ['开发 LifeLens', '写 Electron 代码'] },
        { timestamp: `${day}T10:20:00+08:00`, activity: '继续开发 LifeLens，调试截屏模块捕获逻辑', sentences: ['开发 LifeLens', '调试截屏'] },
      ],
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmp, '2026-07', `summaries-${day}.json`),
    JSON.stringify({
      date: day,
      summaries: {
        [`${day}-10-00`]: { bucket: `${day}-10-00`, startTime: `${day}T10:00:00Z`, project: '开发 LifeLens', category: '工作', description: `用户在本窗口持续开发 LifeLens 项目，编写并调试截屏与录入模块代码，使用 VS Code 与终端。`, software: ['VS Code', '终端'] },
      },
    }),
    'utf8'
  );
}

const cfg = { ...config.DEFAULTS, dataDir: tmp, qaTimeoutMs: 120000 };

(async () => {
  try {
    const res = await qa.askQuestion(cfg, '我最近主要在做什么项目？用了哪些软件？');
    console.log('=== steps ===');
    for (const s of res.steps || []) {
      console.log(
        `第${s.round}轮: done=${s.done}` +
          (s.error ? ` err=${s.error}` : '') +
          (s.results ? ' ' + s.results.map((r) => `${r.source}:${r.count}`).join(',') : '')
      );
    }
    console.log('collectedCount =', res.collectedCount);
    console.log('=== answer ===');
    console.log(res.answer);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    console.error('e2e-qa 失败：', e.message);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
})();

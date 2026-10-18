'use strict';

// 真实调用本地 Ollama 验证“日记（二阶汇总）”链路：
// 合成一天的多窗口 10 分钟汇总 -> 调模型 -> 校验返回结构化日记字段。

const config = require('../config');
const diary = require('../diary');

(async () => {
  const cfg = config.loadConfig();
  const mk = (cat, project, software, desc) => ({
    status: 'ok',
    category: cat,
    project,
    software,
    description: desc,
  });
  const sums = {
    '2026-07-29-09-00': mk('工作', '开发 LifeLens', ['VS Code', '终端'], '重构了截屏录制主循环，修复 backlog 跨月遗漏。'),
    '2026-07-29-09-10': mk('工作', '开发 LifeLens', ['VS Code'], '编写看板聚合模块 analytics.js。'),
    '2026-07-29-10-00': mk('娱乐', '玩《原神》', ['原神', 'Discord'], '和朋友联机刷副本，聊了下周末安排。'),
    '2026-07-29-14-00': mk('学习', '学英语', ['Anki'], '复习了 50 个单词，听了一段播客。'),
    '2026-07-29-15-00': mk('社交', '聊微信', ['微信'], '回复了家人的消息，约了周五聚餐。'),
  };

  console.log('调用 Ollama 生成日记（模型：%s）…', cfg.model);
  const result = await diary.generateDiary(cfg, '2026-07-29', sums);
  console.log('status:', result.status);
  console.log('brief:', result.brief);
  console.log('mainItems:', JSON.stringify(result.mainItems));
  console.log('highlights:', JSON.stringify(result.highlights));
  console.log('todos:', JSON.stringify(result.todos));
  console.log('suggestions:', JSON.stringify(result.suggestions));
  console.log('tips:', result.tips);

  if (result.status !== 'ok') {
    console.error('日记生成失败:', result.error);
    process.exit(1);
  }
  if (!result.brief || result.mainItems.length === 0) {
    console.error('日记字段不完整');
    process.exit(1);
  }
  console.log('\n✔ 日记二阶汇总端到端验证成功');
})().catch((e) => {
  console.error('e2e 失败:', e.message);
  process.exit(1);
});

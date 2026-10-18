'use strict';

// 真实调用 Ollama qwen3-vl 的“十分钟结构化汇总”，验证 generateSummary 产出规范 JSON。
const summary = require('../summary');
const config = require('../config');

(async () => {
  const cfg = config.loadConfig();
  const records = [
    { activity: '用户正在使用 Visual Studio Code 编辑 JavaScript 文件，窗口标题是 main.js。', timestamp: new Date().toISOString() },
    { activity: '用户在浏览器里查看 MDN 文档关于 Promise 的页面。', timestamp: new Date().toISOString() },
    { activity: '用户切换到终端运行 npm test，查看测试结果。', timestamp: new Date().toISOString() },
  ];
  const previous = { project: '开发 LifeLens', category: '工作' };

  const result = await summary.generateSummary(cfg, '2026-07-29-19-00', records, previous);
  console.log('汇总结果：');
  console.log(JSON.stringify(result, null, 2));

  const required = ['bucket', 'project', 'category', 'description', 'software', 'todos', 'status'];
  for (const k of required) {
    if (!(k in result)) throw new Error('缺少字段：' + k);
  }
  if (!['娱乐', '工作', '学习', '社交', '其他'].includes(result.category)) {
    throw new Error('category 非法：' + result.category);
  }
  if (typeof result.description !== 'string' || result.description.length < 10) {
    throw new Error('description 异常');
  }
  console.log('\n✓ 端到端汇总验证成功：模型返回结构化 JSON，字段齐全。');
})().catch((e) => {
  console.error('汇总调用失败：', e.message);
  process.exit(1);
});

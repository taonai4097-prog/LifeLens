'use strict';
// 端到端验证：开放式回顾问题“我最近在干什么”现在能检索到真实数据并回答
// 用法：node test/e2e-qa-open.js   （需本机 Ollama 运行 qwen3-vl:4b-instruct）

const config = require('../config');
const qa = require('../qa');

(async () => {
  const cfg = config.loadConfig();
  console.log('dataDir =', cfg.dataDir);
  console.log('model   =', cfg.model);
  console.log('\n>>> 提问：我最近在干什么\n');
  try {
    const res = await qa.askQuestion(cfg, '我最近在干什么');
    console.log('=== 检索步骤 ===');
    for (const s of res.steps) {
      const qs = (s.queries || [])
        .map((q) => `${q.source}[${q.from}~${q.to}]${q.keywords && q.keywords.length ? ' kw=' + q.keywords.join('/') : ' (全量)'}`)
        .join(' | ');
      console.log(`第${s.round}轮${s.fallback ? '(兜底)' : ''}：${qs || '(无查询)'}`);
      for (const r of s.results || []) {
        console.log(`   → ${r.source} 命中 ${r.count} 条`);
      }
      console.log(`   停止本论：${s.done ? '是' : '否'}`);
    }
    console.log('\n=== 收集片段数：', res.collectedCount, '===');
    console.log('\n=== 模型回答 ===\n' + res.answer);
    if (res.collectedCount === 0) {
      console.error('\n[FAIL] 开放式问题零命中——修复未生效');
      process.exit(1);
    }
    const hit = /LifeLens|开发|工作|日记/.test(res.answer);
    console.log('\n[RESULT]', hit ? '回答包含相关活动关键词 ✓' : '⚠ 回答未明显体现检索内容，请人工核对');
    process.exit(0);
  } catch (e) {
    console.error('调用失败：', e.message);
    process.exit(1);
  }
})();

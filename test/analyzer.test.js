'use strict';

// 纯 Node 下的 analyzer 冒烟测试：验证错误路径与请求构造（不依赖 Electron）
// 注：需要真实 Ollama 才能跑通 analyzeImage 成功路径；这里验证：
//  - checkOllama 在不可达时返回结构化结果
//  - analyzeImage 在连接失败时正确抛错（不崩溃）
const assert = require('assert');

const analyzer = require('../analyzer');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓', name);
}

(async () => {
  // 1) 不可达的 Ollama 返回结构化对象（不抛异常）
  const r = await analyzer.checkOllama('http://127.0.0.1:11434', 'qwen3-vl:4b-instruct');
  assert.ok(typeof r === 'object' && typeof r.reachable === 'boolean', '应返回含 reachable 的对象');
  if (!r.reachable) {
    ok('checkOllama：本地无 Ollama 时优雅返回 reachable=false（符合预期）');
  } else {
    ok('checkOllama：检测到 Ollama 可达，modelInstalled=' + r.modelInstalled);
  }

  // 2) 连接失败时 analyzeImage 必须 reject（验证错误被捕获而非进程崩溃）
  let threw = false;
  try {
    await analyzer.analyzeImage('ZmFrZQ==', {
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3-vl:4b-instruct',
      systemPrompt: 'x',
      prompt: 'x',
      analysisTimeoutMs: 3000,
    });
  } catch (e) {
    threw = true;
    assert.ok(typeof e.message === 'string' && e.message.length > 0, '错误信息应可读');
  }
  assert.ok(threw, '连接失败时应抛出错误');
  ok('analyzeImage：连接失败时正确抛错，错误路径健壮');

  console.log(`\nanalyzer 冒烟测试通过：${passed} 项 ✓`);
})().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});

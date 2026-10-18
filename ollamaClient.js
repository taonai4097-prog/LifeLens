'use strict';

// 统一的 Ollama 调用护栏：
//  1) buildModelOptions —— 依据配置强制「低占用」推理参数（核心修复：不让 LifeLens 占 GPU 显存）
//  2) withModelGate    —— 全局模型互斥，整个应用任意时刻最多 1 个 Ollama 推理在进行
//                        （防止 视觉分析 + 文本汇总 + 日记 + QA 并发挤占 CPU/GPU）
//
// 设计依据（第一性原理 + 对抗式审查）：
//  - 用户的核心痛点：开着 LifeLens 时，自己的 AI 项目抢不到 GPU。根因是 LifeLens 默认把模型
//    整个加载进 GPU 显存（num_gpu_layers 默认=尽可能多）。解法 = 强制 num_gpu_layers=0 → 完全不占
//    显卡，把算力让给你的项目。这是 Ollama 官方 API 行为，比改环境变量可靠（环境变量在某些版本被忽略）。
//  - CPU 也需留余量：num_thread 限制为物理核心的一半，避免 LifeLens 把 CPU 吃满导致整机卡顿。
//  - 攻击推演：CPU-only 跑 4B 视觉模型会变慢 → 但 LifeLens 是后台行为记录，延迟可接受；且我们通过
//    「标题优先分类」已把绝大多数记录挡在模型调用之外，视觉分析本就稀疏。mutex 保证不会叠加卡顿。

const os = require('os');

// —— 全局模型互斥：链式 gate，任意一个推理完成后才放下一个 ——
let chain = Promise.resolve();
function withModelGate(fn) {
  const run = chain.then(fn, fn);
  // 即便 fn 抛错也继续放行后续，绝不阻断队列
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// 依据配置构造 Ollama options。
//  - analysisGpuMode === 'cpu'（默认）：num_gpu_layers=0 → 完全不占 GPU 显存；
//    num_thread = 物理核心的一半（或 cfg.cpuThreads 指定），为其它程序留 CPU 余量。
//  - 'gpu'：让 Ollama 自行决定（默认占满显卡，速度快但会和你其它 AI 任务抢卡）——仅在你不跑其它 AI 时开。
function buildModelOptions(cfg, temperature) {
  const opts = { temperature: temperature ?? 0 };
  const mode = (cfg && cfg.analysisGpuMode) || 'cpu';
  if (mode === 'cpu') {
    opts.num_gpu_layers = 0;
    const cores = (os.cpus() && os.cpus().length) || 4;
    const half = Math.max(1, Math.floor(cores / 2));
    opts.num_thread =
      cfg && cfg.cpuThreads && cfg.cpuThreads > 0 ? cfg.cpuThreads : half;
  }
  return opts;
}

module.exports = { withModelGate, buildModelOptions };

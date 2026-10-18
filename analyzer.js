'use strict';

/**
 * 通过本地 Ollama 的 /api/chat 接口，使用视觉模型分析截屏。
 * qwen3-vl 系列走标准 chat 接口，images 字段传 base64（无需 data URI 前缀）。
 */

const { withModelGate, buildModelOptions } = require('./ollamaClient');

// 检查 Ollama 是否可达，并返回已安装模型中是否包含目标模型
async function checkOllama(baseUrl, model) {
  const base = (baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, reachable: true, modelInstalled: false, status: res.status };
    const data = await res.json();
    const names = (data.models || []).map((m) => (m.name || '').toLowerCase());
    const target = (model || '').toLowerCase();
    return {
      ok: true,
      reachable: true,
      modelInstalled: names.includes(target),
      models: data.models || [],
    };
  } catch (e) {
    return { ok: false, reachable: false, modelInstalled: false, error: e.message };
  }
}

/**
 * 分析单张图片（base64 字符串）。
 * @returns {Promise<string>} 模型返回的文本内容（应是 5 句话）
 */
async function analyzeImage(base64Image, cfg) {
  const base = (cfg.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const url = `${base}/api/chat`;

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'user', content: cfg.prompt, images: [base64Image] },
    ],
    stream: false,
    options: buildModelOptions(cfg, cfg.analysisTemperature ?? 0),
  };

  const res = await withModelGate(() =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.analysisTimeoutMs || 90000),
    })
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ollama 返回 HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data && data.message && data.message.content;
  if (typeof content !== 'string') {
    throw new Error('Ollama 响应缺少 message.content');
  }

  // 可选二次校验：若开启了严格媒体命名，验证《片名》是否有截图可读文字佐证
  if (cfg.strictMediaNaming) {
    return await verifyMediaNaming(base64Image, cfg, content);
  }
  return content;
}

/**
 * 媒体命名二次校验（可选护栏）。
 * 小视觉模型常凭"画面风格"脑补出《繁花》这类错误片名。此函数检测回复中的《片名》，
 * 再让模型只依据"截图中可读的文字"判断是否有佐证；若没有，则把《片名》降级为"媒体内容"。
 * @param {string} base64Image
 * @param {object} cfg
 * @param {string} text 首次分析结果
 * @returns {Promise<string>}
 */
async function verifyMediaNaming(base64Image, cfg, text) {
  const titles = [...text.matchAll(/《([^》]+)》/g)].map((m) => m[1]);
  if (titles.length === 0) return text; // 没有《片名》可校验，直接返回

  const base = (cfg.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const verifyBody = {
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content:
          '你是严格的校验员。只依据截图中"可读的文字"（字幕、文件名、播放器/网页标题栏、UI 文字）判断，' +
          '绝不凭画面风格、人物长相或海报观感。',
      },
      {
        role: 'user',
        content:
          `模型从这张截图推断出了以下具体名称：${titles.join('、')}。\n` +
          '请严格只看截图中是否有清晰可读的文字直接写出这些名称。\n' +
          '若列出的名称里有任何一个在截图中找不到可读文字佐证，回答 NO；若全部都有可读文字佐证，回答 YES。\n' +
          '只回答 YES 或 NO，不要任何解释。',
        images: [base64Image],
      },
    ],
    stream: false,
    options: buildModelOptions(cfg, 0),
  };

  try {
    const res = await withModelGate(() =>
      fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verifyBody),
        signal: AbortSignal.timeout(Math.min(cfg.analysisTimeoutMs || 90000, 30000)),
      })
    );
    if (!res.ok) return text; // 校验失败不阻塞主流程，保守返回原结果
    const data = await res.json();
    const verdict = (data && data.message && data.message.content) || '';
    if (!verdict.toUpperCase().includes('YES')) {
      // 降级：把《...》替换为泛称，避免错误片名沉淀进数据
      return text.replace(/《[^》]+》/g, '媒体内容');
    }
  } catch (_) {
    return text; // 异常时保守返回原结果
  }
  return text;
}

module.exports = { analyzeImage, checkOllama, verifyMediaNaming };

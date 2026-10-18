'use strict';

// 用 zlib 手工生成一张最小有效 PNG（32x32 纯色），再调用真实 Ollama 模型，
// 验证 qwen3-vl 通过标准 chat 接口 + base64 图片能被正确分析并返回文本。
const zlib = require('zlib');
const analyzer = require('../analyzer');

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const row = Buffer.alloc(1 + size * 4);
  row[0] = 0; // filter none
  for (let x = 0; x < size; x++) {
    row[1 + x * 4] = rgb[0];
    row[1 + x * 4 + 1] = rgb[1];
    row[1 + x * 4 + 2] = rgb[2];
    row[1 + x * 4 + 3] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const png = makePng(32, [30, 90, 200]);
  const base64 = png.toString('base64');
  console.log('生成的 PNG 大小(bytes):', png.length);

  const text = await analyzer.analyzeImage(base64, {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:4b-instruct',
    systemPrompt: '你是一个用户行为观察助手，用中文回答。',
    prompt: '这张图片主要内容是什么？请用一句话回答。',
    analysisTimeoutMs: 60000,
  });

  console.log('\n模型返回：\n', text);
  if (typeof text === 'string' && text.trim().length > 0) {
    console.log('\n✓ 端到端验证成功：qwen3-vl 通过标准 chat 接口接受了 base64 图片并返回文本。');
  } else {
    console.log('\n✗ 返回内容异常');
    process.exit(1);
  }
})().catch((e) => {
  console.error('调用失败：', e.message);
  process.exit(1);
});

'use strict';

const { desktopCapturer, screen } = require('electron');

/**
 * 捕获主显示屏的整屏截图，返回压缩后的图片 Buffer。
 * 使用 Electron 内置的 desktopCapturer，无需任何第三方截屏库。
 *
 * 为大幅节省磁盘空间（这是“D 盘爆满”的根因）：
 *  - 直接在 thumbnailSize 阶段把分辨率降到 maxWidth（默认 1600px），避免先产生全分辨率大图；
 *  - 输出 JPEG（有损）而非 PNG，界面/文字截图压缩比极高，模型识别几乎无差异。
 *
 * @param {object} [opts]
 * @param {number} [opts.quality=70]  JPEG 质量 0-100
 * @param {number} [opts.maxWidth=1600] 最大宽度（px），0 = 不缩放
 * @param {number} [opts.tinyWidth]  若给定，额外返回一张等比缩到该宽度的极模糊缩略图（隐私模糊模式用）
 * @returns {Promise<{buffer: Buffer, ext: string, width: number, height: number, tinyBuffer?: Buffer}>}
 */
async function captureScreenshot(opts = {}) {
  const quality = typeof opts.quality === 'number' ? opts.quality : 70;
  const maxWidth = typeof opts.maxWidth === 'number' ? opts.maxWidth : 1600;
  const tinyWidth = typeof opts.tinyWidth === 'number' ? opts.tinyWidth : 0;

  // 以主显示屏分辨率作为基准
  const primary = screen.getPrimaryDisplay();
  const size = primary ? primary.size : { width: 1920, height: 1080 };

  // 若需降分辨率，直接要求 desktopCapturer 产出缩小后的缩略图，避免内存里出现全尺寸大图
  let thumbSize = { width: size.width, height: size.height };
  if (maxWidth && size.width > maxWidth) {
    const ratio = maxWidth / size.width;
    thumbSize = {
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
    };
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: thumbSize,
  });

  if (!sources || sources.length === 0) {
    throw new Error('未找到任何屏幕捕获源');
  }

  // 优先选取“整个屏幕”的源（id 形如 screen:0 / screen:1）
  const wholeScreen =
    sources.find((s) => /^screen:/.test(s.id)) || sources[0];
  const thumb = wholeScreen.thumbnail;

  if (!thumb || thumb.isEmpty()) {
    throw new Error('截屏缩略图为空，可能缺少屏幕捕获权限');
  }

  const dim = thumb.getSize();
  const buffer = thumb.toJPEG(quality);
  // ponytail: tinyBuffer 用 nativeImage.resize 直接降分辨率，无需任何图片库；
  // 降分辨率到 ~360px 后文字已不可读，作为隐私“模糊”的廉价替代（真实像素模糊可后加）。
  let tinyBuffer;
  if (tinyWidth && tinyWidth > 0) {
    const tiny = thumb.resize({ width: Math.min(tinyWidth, dim.width) });
    tinyBuffer = tiny.toJPEG(quality);
  }
  return { buffer, ext: 'jpg', width: dim.width, height: dim.height, tinyBuffer };
}

module.exports = { captureScreenshot };

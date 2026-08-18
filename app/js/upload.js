/**
 * 上传编排：认领文件 → 转码 → tus 分片上传 → 创建谱面。
 *
 * 后端要求四个 tus file ID 齐备（cover / music / chart / preview），少一个就 400。
 * tus 文件 30 分钟过期，所以四个传完要立刻提交。
 */

import { post } from './api.js';
import { uploadFile } from './tus.js';
import {
  PRESET, readBytes, sniff, isOggVorbis, decodeAudio, resample, sliceAudio,
  defaultPreviewRange, encodeOggVorbis, processImage, buildZip,
} from './media.js';

/**
 * 从一堆文件里认领各个角色。
 *
 * 主推谱师直接把游戏导出的那个文件夹整个拖进来——导出产物是
 * base.ogg / base.jpg / 0.aff / bg.jpg / effect.bin / *.wav
 * （见客户端 ChartDetailPanel 的导出逻辑），按名字和魔数就能全部对上号。
 */
export function claimFiles(files) {
  const claimed = { chart: null, music: null, cover: null, background: null, effect: null, wavs: [] };
  const leftover = [];

  for (const file of files) {
    const name = file.name.toLowerCase();

    if (name.endsWith('.aff')) { claimed.chart ??= file; continue; }
    if (name === 'effect.bin') { claimed.effect ??= file; continue; }
    if (name.endsWith('.wav')) { claimed.wavs.push(file); continue; }

    // bg 是谱面内的背景图，base/cover 是曲绘，两者尺寸上限不同，别搞混
    if (/^bg\.(jpe?g|png|webp)$/.test(name)) { claimed.background ??= file; continue; }
    if (file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/.test(name)) {
      claimed.cover ??= file;
      continue;
    }
    if (file.type.startsWith('audio/') || /\.(ogg|mp3|wav|flac|m4a)$/.test(name)) {
      claimed.music ??= file;
      continue;
    }
    leftover.push(file);
  }

  return { ...claimed, leftover };
}

export function describeMissing(claimed) {
  const missing = [];
  if (!claimed.chart) missing.push('谱面文件（.aff）');
  if (!claimed.music) missing.push('音频（base.ogg 或 mp3/wav/flac）');
  if (!claimed.cover) missing.push('曲绘（base.jpg）');
  return missing;
}

/**
 * 转码 + 上传 + 创建。
 *
 * @param {object} claimed  claimFiles 的结果
 * @param {object} meta     表单里的元数据
 * @param {(stage: string, ratio?: number) => void} report 进度回调
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>} 新建谱面的 id
 */
export async function submitLevel(claimed, meta, report, signal) {
  // ---------- 1. 音频 ----------
  report('读取音频');
  const musicBytes = await readBytes(claimed.music);

  // 已经是合规的 Ogg Vorbis 就原样上传。重新编码只是白白掉一代音质，
  // 而谱师手上的 base.ogg 本来就是客户端编好的。
  const musicIsReady = isOggVorbis(musicBytes);

  report('解码音频');
  const decoded = await decodeAudio(claimed.music);

  const range = normalizePreviewRange(meta, decoded.duration);

  let musicBlob;
  if (musicIsReady) {
    musicBlob = new Blob([musicBytes], { type: 'audio/ogg' });
  } else {
    report('转码音频');
    const resampled = await resample(decoded, PRESET.music.sampleRate);
    musicBlob = await encodeOggVorbis(resampled, PRESET.music.vbrQuality);
  }

  report('生成预览片段');
  const previewSource = await resample(
    sliceAudio(decoded, range.start, range.end), PRESET.preview.sampleRate);
  const previewBlob = await encodeOggVorbis(previewSource, PRESET.preview.vbrQuality);

  // ---------- 2. 图片 ----------
  report('处理曲绘');
  const coverBytes = await readBytes(claimed.cover);
  const coverBlob = sniff(coverBytes) === 'jpeg' && claimed.cover.size < 900 * 1024
    ? new Blob([coverBytes], { type: 'image/jpeg' })
    : await processImage(claimed.cover, PRESET.cover);

  // ---------- 3. 谱面包 ----------
  report('打包谱面');
  const entries = [{ name: 'chart.aff', data: await readBytes(claimed.chart) }];

  if (claimed.background) {
    const processed = await processImage(claimed.background, PRESET.background);
    entries.push({ name: 'bg.jpg', data: await readBytes(processed), store: true });
  }
  if (claimed.effect) {
    entries.push({ name: 'effect.bin', data: await readBytes(claimed.effect), store: true });
  }
  for (const wav of claimed.wavs) {
    entries.push({ name: wav.name, data: await readBytes(wav), store: true });
  }
  const chartBlob = await buildZip(entries);

  // ---------- 4. 上传 ----------
  // 四个文件的 tus 记录 30 分钟过期，传完要尽快提交，所以这里不做交互中断
  const uploads = [
    ['cover', coverBlob, 'cover'],
    ['music', musicBlob, 'music'],
    ['chart', chartBlob, 'chart'],
    ['preview', previewBlob, 'preview'],
  ];

  const fileIds = {};
  for (const [index, [fileType, blob, name]] of uploads.entries()) {
    fileIds[fileType] = await uploadFile(blob, {
      fileType,
      name,
      signal,
      onProgress: ratio => report(
        `上传 ${fileType}（${index + 1}/4）`,
        (index + ratio) / uploads.length),
    });
  }

  // ---------- 5. 创建 ----------
  report('提交谱面');
  const created = await post('/api/levels', {
    levelName: meta.levelName,
    composerName: meta.composerName,
    charterName: meta.charterName,
    artistName: meta.artistName,
    baseBpm: meta.baseBpm,
    bpm: meta.bpm || String(meta.baseBpm ?? ''),
    displayDifficulty: meta.displayDifficulty,
    themeColor: meta.themeColor,
    introduction: meta.introduction || null,
    // 谱面加密是客户端 StringEncryptor 干的，网页上传的一律不加密
    isEncryptChart: false,
    allowExport: Boolean(meta.allowExport),
    // 传 0 跳过交叉校验：写库的永远是服务端用 NVorbis 实测的值
    durationSeconds: 0,
    tags: meta.tags,
    coverFileId: fileIds.cover,
    musicFileId: fileIds.music,
    chartFileId: fileIds.chart,
    previewFileId: fileIds.preview,
    previewStart: range.start,
    previewEnd: range.end,
  });

  return created.id;
}

/** 预览区间：用户填了就用，没填按客户端的规则取全曲 30% 处 30 秒；硬上限 60 秒。 */
function normalizePreviewRange(meta, duration) {
  let start = Number(meta.previewStart);
  let end = Number(meta.previewEnd);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    ({ start, end } = defaultPreviewRange(duration));
  }

  start = Math.max(0, Math.min(start, Math.max(0, duration - 1)));
  end = Math.min(end, duration, start + PRESET.preview.maxSeconds);
  if (end <= start) end = Math.min(duration, start + PRESET.preview.defaultSeconds);

  return { start, end };
}

/**
 * 上传编排：扫描目录 → 认领各角色 → 转码 → tus 分片上传 → 创建谱面。
 *
 * 扫描规则逐条移植自客户端 ChartFolderScanner + ChartLibraryPage 的导入流程，
 * 让谱师把同一个目录拖到网页和拖进游戏，认出来的东西一致。
 *
 * 后端要求四个 tus file ID 齐备（cover / music / chart / preview），少一个就 400；
 * 视频是可选的第五个。tus 文件 30 分钟过期，所以传完要立刻提交。
 */

import { post } from './api.js';
import { uploadFile } from './tus.js';
import {
  PRESET, readBytes, sniff, isOggVorbis, decodeAudio, resample, sliceAudio,
  defaultPreviewRange, encodeOggVorbis, processImage, buildZip, probeVideo,
} from './media.js';
import {
  DIFFICULTY_COUNT, DIFF_NAMES, DIFF_COLORS, isSonglistName, parseSonglist,
} from './songlist.js';

// ChartFolderScanner 里的几组扩展名
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tga', 'psd', 'gif'];
const AUDIO_EXTS = ['mp3', 'ogg', 'wav', 'flac', 'aac'];
const VIDEO_EXTS = ['mp4', 'avi', 'mkv', 'webm', 'mov', 'wmv', 'flv', 'm4v'];
/** 背景图和背景视频共用这两个词干 */
const BG_STEMS = ['bg', 'background'];

const extensionOf = name => name.includes('.') ? name.split('.').pop().toLowerCase() : '';
const stemOf = name => name.replace(/\.[^.]*$/, '').toLowerCase();

/**
 * 扫描拖进来的一堆文件，认领各个角色。
 *
 * @returns {{charts: Array<?File>, music: ?File, cover: ?File, songlist: ?File,
 *   effect: ?File, background: ?File, video: ?File, wavs: File[], leftover: File[], error: ?string}}
 */
export function scanFiles(files) {
  const scan = {
    charts: new Array(DIFFICULTY_COUNT).fill(null),
    music: null, cover: null, songlist: null, effect: null,
    background: null, video: null, wavs: [], leftover: [], error: null,
  };

  // 先挑出 base 音频，后面判断 wav 时要拿它排除自己
  for (const file of files) {
    const lower = file.name.toLowerCase();
    const ext = extensionOf(lower);
    const stem = stemOf(lower);

    // 谱面：0.aff ~ 4.aff，数字就是难度档
    if (ext === 'aff') {
      const index = Number.parseInt(stem, 10);
      if (!Number.isInteger(index) || index < 0 || index >= DIFFICULTY_COUNT) continue;
      if (scan.charts[index]) {
        scan.error = `含有多个难度为 ${index} 的谱面`;
        return scan;
      }
      scan.charts[index] = file;
      continue;
    }

    // 曲绘 / 音频：必须是 base.* 或 1080_base.* 前缀，和客户端一致
    if (lower.startsWith('base.') || lower.startsWith('1080_base.')) {
      if (IMAGE_EXTS.includes(ext)) {
        if (scan.cover) { scan.error = '目录内有多个 base 图片文件'; return scan; }
        scan.cover = file;
      } else if (AUDIO_EXTS.includes(ext)) {
        if (scan.music) { scan.error = '目录内有多个 base 音频文件'; return scan; }
        scan.music = file;
      }
      continue;
    }

    if (isSonglistName(lower)) { scan.songlist ??= file; continue; }
    if (lower === 'effect.bin') { scan.effect = file; continue; }

    // 背景图和背景视频同词干，靠扩展名区分
    if (BG_STEMS.includes(stem)) {
      if (IMAGE_EXTS.includes(ext)) { scan.background ??= file; continue; }
      if (VIDEO_EXTS.includes(ext)) { scan.video ??= file; continue; }
    }

    // 其余 wav 是谱面音效，会一起打进谱面包（base.wav 已经在上面被认成音频了）
    if (ext === 'wav') { scan.wavs.push(file); continue; }

    scan.leftover.push(file);
  }

  return scan;
}

/** 目录里实际存在的难度档。 */
export function availableDifficulties(scan) {
  return scan.charts
    .map((file, index) => file ? { index, name: DIFF_NAMES[index], file } : null)
    .filter(Boolean);
}

export function describeMissing(scan) {
  const missing = [];
  if (!availableDifficulties(scan).length) missing.push('谱面文件（0.aff ~ 4.aff）');
  if (!scan.music) missing.push('音频（base.ogg / base.mp3 等）');
  if (!scan.cover) missing.push('曲绘（base.jpg 等）');
  return missing;
}

/**
 * 读 songlist 并按选中的难度档算出预填值。
 *
 * 映射与客户端 ChartLibraryPage 的导入分支一致：曲名取 title_localized.en，
 * 谱师/曲绘取该难度下的 chartDesigner / jacketDesigner，显示难度是
 * "档位名 + rating"，主题色用该档位的预设色。
 */
export async function buildPrefill(scan, difficultyIndex, folderName) {
  const songlist = scan.songlist
    ? parseSonglist(await scan.songlist.text())
    : parseSonglist(null);

  const prefill = {
    levelName: folderName || '',
    composerName: '',
    charterName: '',
    artistName: '',
    baseBpm: 120,
    bpm: '',
    displayDifficulty: `${DIFF_NAMES[difficultyIndex]} ?`,
    themeColor: DIFF_COLORS[difficultyIndex],
    previewStart: 0,
    previewEnd: 0,
    fromSonglist: songlist.hasRead,
  };

  if (!songlist.hasRead) return prefill;

  if (songlist.titleEn) prefill.levelName = songlist.titleEn;
  if (songlist.artist) prefill.composerName = songlist.artist;
  if (songlist.bpmBase > 0) prefill.baseBpm = songlist.bpmBase;
  if (songlist.bpm) prefill.bpm = songlist.bpm;
  prefill.previewStart = songlist.previewStart;
  prefill.previewEnd = songlist.previewEnd;

  const diff = songlist.difficulties[difficultyIndex];
  if (diff) {
    if (diff.chartDesigner) prefill.charterName = diff.chartDesigner;
    if (diff.jacketDesigner) prefill.artistName = diff.jacketDesigner;
    prefill.displayDifficulty =
      `${DIFF_NAMES[difficultyIndex]} ${diff.rating === 0 ? '?' : diff.rating}`;
  }

  return prefill;
}

/**
 * 转码 + 上传 + 创建。
 *
 * @param {object} scan             scanFiles 的结果
 * @param {number} difficultyIndex  要上传哪个难度档
 * @param {object} meta             表单里的元数据
 * @param {(stage: string, ratio?: number) => void} report
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>} 新建谱面的 id
 */
export async function submitLevel(scan, difficultyIndex, meta, report, signal) {
  const chartFile = scan.charts[difficultyIndex];
  if (!chartFile) throw new Error('选中的难度没有对应的谱面文件');

  // ---------- 1. 音频 ----------
  report('读取音频');
  const musicBytes = await readBytes(scan.music);

  // 已经是合规 Ogg Vorbis 就原样上传：重新编码只是白掉一代音质，
  // 而谱师手上的 base.ogg 本来就是客户端编好的
  const musicIsReady = isOggVorbis(musicBytes);

  report('解码音频');
  const decoded = await decodeAudio(scan.music);
  const range = normalizePreviewRange(meta, decoded.duration);

  let musicBlob;
  if (musicIsReady) {
    musicBlob = new Blob([musicBytes], { type: 'audio/ogg' });
  } else {
    report('转码音频');
    musicBlob = await encodeOggVorbis(
      await resample(decoded, PRESET.music.sampleRate), PRESET.music.vbrQuality);
  }

  report('生成预览片段');
  const previewBlob = await encodeOggVorbis(
    await resample(sliceAudio(decoded, range.start, range.end), PRESET.preview.sampleRate),
    PRESET.preview.vbrQuality);

  // ---------- 2. 曲绘 ----------
  report('处理曲绘');
  const coverBytes = await readBytes(scan.cover);
  const coverBlob = sniff(coverBytes) === 'jpeg' && scan.cover.size < 900 * 1024
    ? new Blob([coverBytes], { type: 'image/jpeg' })
    : await processImage(scan.cover, PRESET.cover);

  // ---------- 3. 谱面包 ----------
  report('打包谱面');
  const entries = [{ name: 'chart.aff', data: await readBytes(chartFile) }];

  if (scan.background) {
    const processed = await processImage(scan.background, PRESET.background);
    entries.push({ name: 'bg.jpg', data: await readBytes(processed), store: true });
  }
  if (scan.effect) {
    entries.push({ name: 'effect.bin', data: await readBytes(scan.effect), store: true });
  }
  for (const wav of scan.wavs) {
    entries.push({ name: wav.name, data: await readBytes(wav), store: true });
  }
  const chartBlob = await buildZip(entries);

  // ---------- 4. 上传 ----------
  const uploads = [
    ['cover', coverBlob, 'cover'],
    ['music', musicBlob, 'music'],
    ['chart', chartBlob, 'chart'],
    ['preview', previewBlob, 'preview'],
  ];
  // 视频只在通过预检时才带上——浏览器转不了码，不合规的话上传也是白传
  if (meta.includeVideo && scan.video) {
    uploads.push(['video', scan.video, scan.video.name]);
  }

  const fileIds = {};
  for (const [index, [fileType, blob, name]] of uploads.entries()) {
    fileIds[fileType] = await uploadFile(blob, {
      fileType, name, signal,
      onProgress: ratio => report(
        `上传 ${fileType}（${index + 1}/${uploads.length}）`,
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
    // 传 0 跳过交叉校验：写库的永远是服务端 NVorbis 实测的值
    durationSeconds: 0,
    tags: meta.tags,
    coverFileId: fileIds.cover,
    musicFileId: fileIds.music,
    chartFileId: fileIds.chart,
    previewFileId: fileIds.preview,
    videoFileId: fileIds.video ?? null,
    previewStart: range.start,
    previewEnd: range.end,
  });

  return created.id;
}

export { probeVideo };

/**
 * 预览区间：songlist 或用户填了就用，否则按客户端规则取全曲 30% 处 30 秒。
 * 硬上限 60 秒，超了后端会 400。
 */
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

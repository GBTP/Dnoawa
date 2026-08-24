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
  PRESET, readBytes, decodeAudio, resample, sliceAudio, defaultPreviewRange,
  encodeOggVorbis, processImage, buildZip, probeVideo,
  imageNeedsNoWork, audioNeedsNoWork,
} from './media.js';
import {
  DIFFICULTY_COUNT, DIFF_NAMES, DIFF_COLORS, isSonglistName, parseSonglist,
} from './songlist.js';
import { isArcadeProjectPath, parseArcadeProject } from './arcade.js';

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
 * @returns {{charts: Array<?File>, chartCandidates: File[][], music: ?File, cover: ?File,
 *   songlist: ?File, effect: ?File, background: ?File, video: ?File, wavs: File[],
 *   leftover: File[], conflicts: Array, candidates: object, error: ?string}}
 */
export function scanFiles(files) {
  const scan = {
    charts: new Array(DIFFICULTY_COUNT).fill(null),
    chartCandidates: Array.from({ length: DIFFICULTY_COUNT }, () => []),
    music: null, cover: null, songlist: null, effect: null,
    background: null, video: null, arcadeProject: null,
    wavs: [], leftover: [], conflicts: [], error: null,
    candidates: {
      music: [], cover: [], songlist: [], effect: [], background: [], video: [],
    },
  };

  const addCandidate = (kind, file) => {
    scan.candidates[kind].push(file);
    if (!scan[kind]) scan[kind] = file;
    else if (scan[kind] !== file) {
      const existing = scan.candidates[kind];
      if (!scan.conflicts.some(item => item.kind === kind)) {
        scan.conflicts.push({ kind, files: existing });
      }
    }
  };

  for (const file of files) {
    const lower = file.name.toLowerCase();
    const ext = extensionOf(lower);
    const stem = stemOf(lower);
    const relative = file.webkitRelativePath || file.name;

    if (isArcadeProjectPath(relative) || lower === 'project.arcade') {
      scan.arcadeProject ??= file;
      if (scan.arcadeProject !== file) scan.leftover.push(file);
      continue;
    }

    if (ext === 'aff') {
      const index = Number.parseInt(stem, 10);
      if (!Number.isInteger(index) || index < 0 || index >= DIFFICULTY_COUNT) {
        scan.leftover.push(file);
        continue;
      }
      scan.chartCandidates[index].push(file);
      if (!scan.charts[index]) scan.charts[index] = file;
      else scan.conflicts.push({ kind: `chart-${index}`, files: scan.chartCandidates[index] });
      continue;
    }

    if (lower.startsWith('base.') || lower.startsWith('1080_base.')) {
      if (IMAGE_EXTS.includes(ext)) addCandidate('cover', file);
      else if (AUDIO_EXTS.includes(ext)) addCandidate('music', file);
      else scan.leftover.push(file);
      continue;
    }

    if (isSonglistName(lower)) { addCandidate('songlist', file); continue; }
    if (lower === 'effect.bin') { addCandidate('effect', file); continue; }

    if (BG_STEMS.includes(stem)) {
      if (IMAGE_EXTS.includes(ext)) { addCandidate('background', file); continue; }
      if (VIDEO_EXTS.includes(ext)) { addCandidate('video', file); continue; }
    }

    if (ext === 'wav') { scan.wavs.push(file); continue; }
    scan.leftover.push(file);
  }

  // 不重复添加同一冲突，便于 UI 直接列出每组候选。
  scan.conflicts = scan.conflicts.filter((item, index, all) =>
    all.findIndex(other => other.kind === item.kind) === index);
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

  const arcade = scan.arcadeProject
    ? parseArcadeProject(await scan.arcadeProject.text())
    : parseArcadeProject(null);

  const prefill = {
    levelName: folderName || '',
    /** songlist 里有几种语言的曲名就列几种，交给用户挑。空对象表示没得挑。 */
    titleOptions: {},
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
    fromArcade: arcade.hasRead,
  };

  // Arcade 工程文件先垫一层，顺序与客户端 ChartFolderImporter 一致：
  // 它只有曲名/曲师/BaseBpm 三样，但谱师的工作目录常常只有它没有 songlist，
  // 没它的话 BaseBpm 只能落到 120，游戏里的流速会不对。
  // 放在 songlist 前面是因为 songlist 信息更全（还有难度评级、画师、试听区间），
  // 两者都在时以 songlist 为准。
  if (arcade.title) prefill.levelName = arcade.title;
  if (arcade.artist) prefill.composerName = arcade.artist;
  if (arcade.baseBpm > 0) prefill.baseBpm = arcade.baseBpm;

  if (!songlist.hasRead) return prefill;

  prefill.titleOptions = songlist.titles;
  // 默认仍取 en，和客户端一致；没有 en 就用出现的第一种，再没有才回落文件夹名
  const firstTitle = Object.values(songlist.titles)[0];
  prefill.levelName = songlist.titles.en || firstTitle || prefill.levelName;

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
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {AudioBuffer} [options.decoded] 页面上画波形时已经解好的音频，传进来免得再解一遍
 * @returns {Promise<number>} 新建谱面的 id
 */
export async function submitLevel(scan, difficultyIndex, meta, report, { signal, decoded, chartBlob } = {}) {
  const chartFile = scan.charts[difficultyIndex];
  if (!chartFile) throw new Error('选中的难度没有对应的谱面文件');

  // ---------- 1. 音频 ----------
  report('读取音频');
  const musicBytes = await readBytes(scan.music);

  let buffer = decoded;
  if (!buffer) {
    report('解码音频');
    buffer = await decodeAudio(scan.music);
  }
  const range = normalizePreviewRange(meta, buffer.duration);

  // 已经完全合规才原样上传（OGG Vorbis + 44100 + 码率达标）：重新编码只是白掉
  // 一代音质，而谱师手上的 base.ogg 多半就是客户端编好的。但采样率或码率不对
  // 时必须重编——客户端 TryDecode 判的就是 44100，后端会拒超 750kbps 的。
  const musicIsReady = audioNeedsNoWork(musicBytes, buffer);

  let musicBlob;
  if (musicIsReady) {
    musicBlob = new Blob([musicBytes], { type: 'audio/ogg' });
  } else {
    report('转码音频');
    musicBlob = await encodeOggVorbis(
      await resample(buffer, PRESET.music.sampleRate), PRESET.music.vbrQuality);
  }

  report('生成预览片段');
  const previewBlob = await encodeOggVorbis(
    await resample(sliceAudio(buffer, range.start, range.end), PRESET.preview.sampleRate),
    PRESET.preview.vbrQuality);

  // ---------- 2. 曲绘 ----------
  report('处理曲绘');
  const coverBytes = await readBytes(scan.cover);
  // 看分辨率而不是文件大小：4000×4000 但压得狠的 JPEG 可能只有 800KB，
  // 按大小判会把超规格的图原样传上去
  const coverBlob = imageNeedsNoWork(coverBytes, PRESET.cover)
    ? new Blob([coverBytes], { type: 'image/jpeg' })
    : await processImage(scan.cover, PRESET.cover);

  // ---------- 3. 谱面包 ----------
  report('打包谱面');
  let finalChartBlob = chartBlob;
  if (!finalChartBlob) {
    const entries = [{ name: 'chart.aff', data: await readBytes(chartFile) }];

    if (scan.background) {
      // 和封面同样的规则：已经是合规尺寸的 JPEG 就不重编码
      const bgBytes = await readBytes(scan.background);
      const bgData = imageNeedsNoWork(bgBytes, PRESET.background)
        ? bgBytes
        : await readBytes(await processImage(scan.background, PRESET.background));
      entries.push({ name: 'bg.jpg', data: bgData, store: true });
    }
    if (scan.effect) {
      entries.push({ name: 'effect.bin', data: await readBytes(scan.effect), store: true });
    }
    for (const wav of scan.wavs) {
      entries.push({ name: wav.name, data: await readBytes(wav), store: true });
    }
    finalChartBlob = await buildZip(entries);
  }

  // ---------- 4. 上传 ----------
  const uploads = [
    ['cover', coverBlob, 'cover'],
    ['music', musicBlob, 'music'],
    ['chart', finalChartBlob, 'chart'],
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
    // BaseBpm 是参与玩法的数值，Bpm 是纯展示字符串（可以是 "174-186" 这种区间），
    // 客户端 LevelEditPanel 里就是两个独立输入框。留空要发 null 而不是空串——
    // 后端是 `request.Bpm ?? request.BaseBpm.ToString("F0")`，空串不是 null，
    // 会被原样存成空的展示 BPM。
    bpm: meta.bpm?.trim() || null,
    displayDifficulty: meta.displayDifficulty,
    themeColor: meta.themeColor,
    introduction: meta.introduction || null,
    // 空串要发 null 而不是 ""：后端 ParseRecommendedTheme 对空白按 Unspecified 处理，
    // 但 chartConstant 是 float?，"" 会绑定失败整个请求 400
    recommendedTheme: meta.recommendedTheme || null,
    // 留空就不给，让服务端从显示难度猜一个打底
    chartConstant: meta.chartConstant === '' ? null : Number(meta.chartConstant),
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

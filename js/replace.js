/**
 * 逐个替换已有谱面的资源。
 *
 * 后端 UpdateLevelAsync 的五个 *FileId 都是独立可选的，所以网页可以只换一样。
 * 客户端那边只能整包替换（重扫目录、元数据保持原样），这里反而更灵活。
 *
 * 三条要记住的后端行为：
 * - 换任意资源会让 ResourceVersion++，客户端据此判断要不要重新下载
 * - 旧文件进删除队列，不会立刻消失，失败可重试
 * - **非管理员换完照样重审**（Status 重置为 Pending）
 */

import { uploadFile } from './tus.js';
import {
  PRESET, readBytes, sniff, isOggVorbis, decodeAudio, resample, sliceAudio,
  encodeOggVorbis, processImage, buildZip, probeVideo,
} from './media.js';

/**
 * 每种资源的处理方式。转码规则与上传页完全一致——同一张谱面从上传和替换
 * 两条路进来，产出必须一样。
 */
export const RESOURCE_KINDS = {
  cover: {
    label: '封面',
    accept: 'image/*',
    fileType: 'cover',
    field: 'coverFileId',
    hint: '会压到 1024×1024 以内的 JPEG。已经是合规 JPEG 的原样上传。',
  },
  music: {
    label: '音乐',
    accept: 'audio/*,.ogg,.mp3,.wav,.flac',
    fileType: 'music',
    field: 'musicFileId',
    hint: '会转成 OGG Vorbis。换音乐会连带重算时长，也需要同时更新预览片段。',
    warn: '换音乐会让所有人的历史成绩对不上新谱面，除非谱面本身没变。',
  },
  chart: {
    label: '谱面包',
    accept: '.aff,.zip',
    fileType: 'chart',
    field: 'chartFileId',
    hint: '可以直接给 .aff，会自动打成谱面包；给 .zip 则原样上传。',
    warn: '换谱面后旧成绩就不再对应当前谱面了。',
  },
  preview: {
    label: '预览音频',
    accept: 'audio/*,.ogg,.mp3,.wav,.flac',
    fileType: 'preview',
    field: 'previewFileId',
    hint: '选曲界面试听的那一段，最长 60 秒。',
  },
  video: {
    label: '背景视频',
    accept: 'video/mp4,.mp4',
    fileType: 'video',
    field: 'videoFileId',
    hint: '必须是 MP4/H.264，≤150MB、≤8Mbps、短边 ≤760、长边 ≤1000。',
  },
};

/**
 * 把用户选的文件处理成可上传的 Blob。
 *
 * @param {string} kind    RESOURCE_KINDS 的键
 * @param {File} file
 * @param {(stage: string) => void} report
 * @param {{previewRange?: {start: number, end: number}}} [options]
 * @returns {Promise<{blob: Blob, name: string}>}
 */
export async function prepareResource(kind, file, report, options = {}) {
  switch (kind) {
    case 'cover': {
      report('处理封面');
      const bytes = await readBytes(file);
      // 已经是合规 JPEG 就原样上传，重编码只是白掉一代画质
      const blob = sniff(bytes) === 'jpeg' && file.size < 900 * 1024
        ? new Blob([bytes], { type: 'image/jpeg' })
        : await processImage(file, PRESET.cover);
      return { blob, name: 'cover' };
    }

    case 'music': {
      report('读取音频');
      const bytes = await readBytes(file);
      if (isOggVorbis(bytes)) {
        return { blob: new Blob([bytes], { type: 'audio/ogg' }), name: 'music' };
      }
      report('转码音频');
      const decoded = await decodeAudio(file);
      const blob = await encodeOggVorbis(
        await resample(decoded, PRESET.music.sampleRate), PRESET.music.vbrQuality);
      return { blob, name: 'music' };
    }

    case 'preview': {
      report('读取音频');
      const decoded = await decodeAudio(file);
      const range = options.previewRange;

      // 没给区间、且整个文件已经是合规的 OGG Vorbis 且不超 60 秒，就原样传，
      // 免得白掉一代音质。给了区间就必须走切片——用户框了区间却不生效是更糟的。
      if (!range) {
        const bytes = await readBytes(file);
        if (isOggVorbis(bytes) && decoded.duration <= PRESET.preview.maxSeconds) {
          return { blob: new Blob([bytes], { type: 'audio/ogg' }), name: 'preview' };
        }
      }

      report('生成预览片段');
      const start = Math.max(0, range?.start ?? 0);
      const end = Math.min(
        range?.end ?? PRESET.preview.maxSeconds,
        start + PRESET.preview.maxSeconds,
        decoded.duration);
      const blob = await encodeOggVorbis(
        await resample(sliceAudio(decoded, start, end), PRESET.preview.sampleRate),
        PRESET.preview.vbrQuality);
      return { blob, name: 'preview', range: { start, end } };
    }

    case 'chart': {
      report('打包谱面');
      const bytes = await readBytes(file);
      // 已经是 zip 就原样传；给的是裸 .aff 就替他打包
      if (sniff(bytes) === 'zip') {
        return { blob: new Blob([bytes], { type: 'application/zip' }), name: 'chart' };
      }
      const blob = await buildZip([{ name: 'chart.aff', data: bytes }]);
      return { blob, name: 'chart' };
    }

    case 'video': {
      report('检查视频');
      // 浏览器里转不了码，只能验合规性——不合规就别白传一趟
      const probe = await probeVideo(file);
      if (!probe.ok) throw new Error(probe.reason);
      return { blob: file, name: file.name };
    }

    default:
      throw new Error(`未知的资源类型: ${kind}`);
  }
}

/**
 * 处理并上传一个资源，返回可直接放进 UpdateLevelRequest 的 patch 片段。
 */
export async function uploadResource(kind, file, report, options = {}) {
  const spec = RESOURCE_KINDS[kind];
  if (!spec) throw new Error(`未知的资源类型: ${kind}`);

  const { blob, name, range } = await prepareResource(kind, file, report, options);

  const fileId = await uploadFile(blob, {
    fileType: spec.fileType,
    name,
    onProgress: ratio => report(`上传${spec.label} ${Math.round(ratio * 100)}%`),
  });

  const patch = { [spec.field]: fileId };
  // 预览区间只在同时提交 previewFileId 时才会被后端采纳
  if (range) {
    patch.previewStart = range.start;
    patch.previewEnd = range.end;
  }
  return patch;
}

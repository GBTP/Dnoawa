/**
 * 上传前的资源转码与打包。
 *
 * 目标是让网页上传的产物与客户端上传的**逐参数一致**，否则同一张谱面从两边传
 * 会得到不同画质/音质。参数出处：
 *   Anoawa/Assets/Scripts/Anoawa/Utils/AssetTranscoder.cs:88-100
 *   Anoawa/Assets/Scripts/Anoawa/UI/Pages/ChartLibraryPage.cs:876-886
 *   Anoawa/Assets/Scripts/Anoawa/Managers/Static/LocalChartManager.cs:250-281
 */

import { decodeOggVorbis } from './audio.js';

/** 与客户端对齐的转码参数。改这里之前先确认客户端那边有没有一起改。 */
export const PRESET = {
  cover: { maxWidth: 1024, maxHeight: 1024, quality: 0.85 },
  background: { maxWidth: 1280, maxHeight: 960, quality: 0.85 },
  music: { vbrQuality: 0.6, sampleRate: 44100 },
  preview: { vbrQuality: 0.1, sampleRate: 44100, defaultSeconds: 30, maxSeconds: 60 },
};

const ENCODER_WASM = 'vendor/ogg.wasm';
const ENCODER_SRC = 'vendor/WasmMediaEncoder.min.js';

// ---------- 文件识别 ----------

export async function readBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** 按魔数判断类型，不信扩展名——用户从游戏导出的文件可能压根没有扩展名。 */
export function sniff(bytes) {
  const startsWith = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x4f, 0x67, 0x67, 0x53)) return 'ogg';      // OggS
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpeg';
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'zip';
  if (startsWith(0x52, 0x49, 0x46, 0x46)) return 'wav';      // RIFF
  if (startsWith(0x49, 0x44, 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3';
  return 'unknown';
}

/** 后端 AudioValidationService 的码率上限。超了 tus 上传的最后一片会 400。 */
export const MAX_AUDIO_KBPS = 750;

/**
 * 这段音频能不能原样上传。三个条件缺一不可，对齐客户端
 * AssetTranscoder.TryDecode 和后端 AudioValidationService 的校验：
 *
 * - 必须是 OGG Vorbis（后端只认这个）
 * - 采样率必须是 44100（客户端 TryDecode 判的就是这个，不是就重编码）
 * - 实际码率不超 750kbps（后端会拒，口径是 文件大小×8÷时长）
 *
 * @param {Uint8Array} bytes
 * @param {AudioBuffer} decoded 已解码的音频，用来拿采样率和时长
 */
export function audioNeedsNoWork(bytes, decoded) {
  if (!isOggVorbis(bytes)) return false;
  if (decoded.sampleRate !== PRESET.music.sampleRate) return false;

  const kbps = decoded.duration > 0 ? (bytes.length * 8) / decoded.duration / 1000 : Infinity;
  return kbps <= MAX_AUDIO_KBPS;
}

/** Ogg 容器里装的是不是 Vorbis（可能是 Opus/FLAC，后端只认 Vorbis）。 */
export function isOggVorbis(bytes) {
  if (sniff(bytes) !== 'ogg') return false;
  // 第一个 packet 是 identification header：0x01 + "vorbis"
  const head = bytes.subarray(0, 64);
  for (let i = 0; i < head.length - 7; i += 1) {
    if (head[i] === 0x01 && String.fromCharCode(...head.subarray(i + 1, i + 7)) === 'vorbis') return true;
  }
  return false;
}

/**
 * 读 JPEG/PNG 的宽高，只解文件头，不解码整张图。
 *
 * 判断"这张图要不要处理"必须看分辨率——用文件大小当代理是错的：
 * 一张 4000×4000 但压得很狠的 JPEG 可能只有 800KB，原样传上去客户端那边
 * 拿到的就是超规格的图（ProcessCoverAsync 里 > maxWidth 就一定会 Resize）。
 *
 * @returns {?{width: number, height: number}} 认不出返回 null
 */
export function imageSize(bytes) {
  const kind = sniff(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (kind === 'png') {
    // IHDR 固定在偏移 16，宽高各 4 字节大端
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (kind === 'jpeg') {
    // 扫段直到 SOFn。0xC4/0xC8/0xCC 不是 SOF，分别是 DHT/JPG/DAC
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) return null;
      i += 2 + len;
    }
  }

  return null;
}

/**
 * 这张图能不能原样上传：必须已经是 JPEG，且分辨率在上限内。
 * 认不出尺寸时返回 false——宁可多处理一次，也别把超规格的图传上去。
 */
export function imageNeedsNoWork(bytes, { maxWidth, maxHeight }) {
  if (sniff(bytes) !== 'jpeg') return false;
  const size = imageSize(bytes);
  if (!size) return false;
  return size.width <= maxWidth && size.height <= maxHeight;
}

// ---------- 音频 ----------

let audioCtx = null;

/** 全模块共用一个 AudioContext——浏览器对同时存在的 context 数量有上限。 */
export function audioContext() {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
const context = audioContext;

/**
 * 解码任意音频文件成 AudioBuffer。
 *
 * 先用浏览器原生的 decodeAudioData（mp3/wav/m4a/flac 到处都能解，ogg 在
 * Chrome/Firefox 能解），失败且确实是 Ogg 时才退到 WASM 解码器——
 * Safari 解不了 Vorbis，而谱师手上的 base.ogg 恰恰就是 Vorbis。
 */
export async function decodeAudio(file) {
  const bytes = await readBytes(file);

  try {
    // decodeAudioData 会 detach 传入的 buffer，必须给它一份拷贝，
    // 否则失败后 bytes 已经不能再用了
    return await context().decodeAudioData(bytes.slice().buffer);
  } catch (error) {
    if (!isOggVorbis(bytes)) {
      throw new Error('无法识别的音频格式，请提供 ogg / mp3 / wav / flac');
    }
    return decodeOggVorbis(bytes);
  }
}

/** 重采样并混到指定声道数。OfflineAudioContext 原生就干这件事。 */
export async function resample(buffer, sampleRate, channels = Math.min(buffer.numberOfChannels, 2)) {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === channels) return buffer;

  const frames = Math.ceil(buffer.duration * sampleRate);
  const offline = new OfflineAudioContext(channels, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/** 截取一段。用于生成预览片段。 */
export function sliceAudio(buffer, startSeconds, endSeconds) {
  const rate = buffer.sampleRate;
  const from = Math.max(0, Math.floor(startSeconds * rate));
  const to = Math.min(buffer.length, Math.floor(endSeconds * rate));
  const frames = Math.max(1, to - from);

  const out = context().createBuffer(buffer.numberOfChannels, frames, rate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    out.copyToChannel(buffer.getChannelData(ch).subarray(from, to), ch);
  }
  return out;
}

/**
 * 客户端算预览区间的规则（LocalChartManager.GeneratePreviewClip）：
 * 没设过区间就从全曲 30% 处开始、取 30 秒；设过就用设的值。
 */
export function defaultPreviewRange(durationSeconds) {
  const start = durationSeconds * 0.3;
  const end = Math.min(start + PRESET.preview.defaultSeconds, durationSeconds);
  return { start, end };
}

let encoderScriptPromise = null;
function loadEncoderScript() {
  encoderScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ENCODER_SRC;
    script.onload = resolve;
    script.onerror = () => reject(new Error('音频编码器加载失败'));
    document.head.append(script);
  });
  return encoderScriptPromise;
}

/**
 * 编码成 OGG Vorbis。
 *
 * 刻意不用库里的 createOggEncoder()——它把 wasm 地址硬编码成了 unpkg.com，
 * 国内大概率拉不到。createEncoder(mime, url) 是它的通用形式，直接指到本地。
 *
 * @param {AudioBuffer} buffer
 * @param {number} vbrQuality libvorbis 的质量刻度，-1~10，与客户端 NativeOggEncoder 同一套
 */
export async function encodeOggVorbis(buffer, vbrQuality) {
  await loadEncoderScript();

  const encoder = await window.WasmMediaEncoder.createEncoder('audio/ogg', ENCODER_WASM);
  encoder.configure({
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    vbrQuality,
  });

  const channels = Array.from(
    { length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));

  const parts = [];
  // 分块喂，避免一次性把整首歌的 PCM 复制进 wasm 堆。
  // encode() 返回的是指向 wasm 内存的视图，下次调用会被覆写，必须 slice 拷出来。
  const step = buffer.sampleRate * 10;
  for (let offset = 0; offset < buffer.length; offset += step) {
    const end = Math.min(offset + step, buffer.length);
    parts.push(encoder.encode(channels.map(c => c.subarray(offset, end))).slice());
  }
  parts.push(encoder.finalize().slice());

  return new Blob(parts, { type: 'audio/ogg' });
}

// ---------- 图片 ----------

/**
 * 缩放并转成 JPEG。浏览器原生就够用，不需要 WASM。
 *
 * 分级缩放（每次最多减半）而不是一步到位：canvas 的 drawImage 是双线性采样，
 * 从 3000px 直接压到 1024px 会有明显锯齿，分几步降质量好得多——
 * 客户端那边用的是 Lanczos3，这是浏览器里最接近的做法。
 */
export async function processImage(file, { maxWidth, maxHeight, quality }) {
  const bitmap = await createImageBitmap(file);
  try {
    let { width, height } = bitmap;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    let canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    let ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    while (width > targetWidth * 2) {
      width = Math.max(targetWidth, Math.round(width / 2));
      height = Math.max(targetHeight, Math.round(height / 2));
      const next = document.createElement('canvas');
      next.width = width;
      next.height = height;
      const nextCtx = next.getContext('2d');
      nextCtx.imageSmoothingQuality = 'high';
      nextCtx.drawImage(canvas, 0, 0, width, height);
      canvas = next;
      ctx = nextCtx;
    }

    if (width !== targetWidth || height !== targetHeight) {
      const final = document.createElement('canvas');
      final.width = targetWidth;
      final.height = targetHeight;
      const finalCtx = final.getContext('2d');
      finalCtx.imageSmoothingQuality = 'high';
      finalCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
      canvas = final;
    }

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('图片编码失败')),
        'image/jpeg', quality);
    });
  } finally {
    bitmap.close?.();
  }
}

// ---------- 背景视频 ----------

/**
 * 后端 VideoValidationService 的硬限制。改这里之前先看服务端有没有一起改。
 */
export const VIDEO_LIMITS = {
  maxBytes: 150 * 1024 * 1024,
  maxBitrateBps: 8_000_000,
  maxShortSide: 760,
  maxLongSide: 1000,
};

/**
 * 检查一个视频能不能直接上传。
 *
 * 浏览器里做不了转码——客户端用 VideoNormalizer 转 MP4/H.264，网页要对等就得引
 * ffmpeg.wasm（25MB 起），代价太大。所以只做"合规就透传、不合规就说清楚"：
 * 用原生 <video> 读尺寸和时长（能读出来本身就说明浏览器解得开这个编码），
 * 再按后端的四条限制判一遍，把 400 提前到上传之前。
 *
 * @returns {Promise<{ok: boolean, reason?: string, width?: number, height?: number,
 *   duration?: number, bitrate?: number}>}
 */
export async function probeVideo(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isMp4 = String.fromCharCode(...head.subarray(4, 8)) === 'ftyp';
  if (!isMp4) {
    return { ok: false, reason: '不是 MP4 容器，后端只接受 MP4/H.264' };
  }
  if (file.size > VIDEO_LIMITS.maxBytes) {
    return { ok: false, reason: `文件 ${(file.size / 1024 / 1024).toFixed(0)}MB 超过上限 150MB` };
  }

  const meta = await readVideoMetadata(file);
  if (!meta) {
    return { ok: false, reason: '浏览器无法解码这个视频，可能不是 H.264 编码' };
  }

  const shortSide = Math.min(meta.width, meta.height);
  const longSide = Math.max(meta.width, meta.height);
  if (shortSide > VIDEO_LIMITS.maxShortSide || longSide > VIDEO_LIMITS.maxLongSide) {
    return {
      ok: false,
      ...meta,
      reason: `分辨率 ${meta.width}×${meta.height} 超限（短边需 ≤${VIDEO_LIMITS.maxShortSide}，长边需 ≤${VIDEO_LIMITS.maxLongSide}）`,
    };
  }

  const bitrate = meta.duration > 0 ? (file.size * 8) / meta.duration : 0;
  if (bitrate > VIDEO_LIMITS.maxBitrateBps) {
    return {
      ok: false,
      ...meta,
      bitrate,
      reason: `码率约 ${(bitrate / 1e6).toFixed(1)}Mbps 超过上限 8Mbps`,
    };
  }

  return { ok: true, ...meta, bitrate };
}

function readVideoMetadata(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const done = result => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(result);
    };

    video.onloadedmetadata = () => done({
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    });
    video.onerror = () => done(null);
    // 有些容器 metadata 事件不触发，别把界面吊死在这
    setTimeout(() => done(null), 8000);

    video.src = url;
  });
}

// ---------- ZIP 打包 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 打一个 ZIP。条目名必须与客户端 ZipChartPackage 读取时用的完全一致
 * （chart.aff / bg.jpg / effect.bin / *.wav），差一个字母客户端就读不到。
 *
 * 只用 CompressionStream('deflate-raw') 这个原生 API，不引 zip 库。
 * 已经压过的资源（jpg / ogg）用 store，再 deflate 一遍只会更大更慢。
 *
 * @param {Array<{name: string, data: Uint8Array, store?: boolean}>} entries
 */
export async function buildZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const store = entry.store ?? false;
    const body = store ? entry.data : await deflateRaw(entry.data);
    const method = store ? 0 : 8;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // bit 11：文件名按 UTF-8 解释
    local.setUint16(8, method, true);
    local.setUint16(10, 0, true);          // 时间
    local.setUint16(12, 0x21, true);       // 日期：1980-01-01，不泄漏本机时间
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    chunks.push(new Uint8Array(local.buffer), name, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);            // version made by
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, 0, true);
    dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, entry.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);       // 本地头偏移
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
    { type: 'application/zip' });
}

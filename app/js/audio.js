/**
 * 试听播放。
 *
 * 后端强制谱面音频为 OGG Vorbis（NVorbis 校验），但 **Safari 在 macOS 和 iOS 上
 * 都放不了 Vorbis**（MDN 的编解码器兼容表里 Safari 一栏是 No），<audio> 会直接
 * 报 MEDIA_ERR_SRC_NOT_SUPPORTED（code 4）。
 *
 * 所以按能力分支：能原生播的走 <audio>，零额外开销；不能的才懒加载
 * vendor/ogg-vorbis-decoder.min.js（99KB，wasm 已内联）解成 PCM 走 Web Audio。
 * 解码器只在真正需要时下载一次，Chrome/Firefox 用户完全不付这个成本。
 *
 * 注意：原生 <audio> 播跨域资源不需要 CORS，但这里要 fetch() 读字节，
 * **需要 CDN 返回 Access-Control-Allow-Origin**。拿不到就只能退化成提示。
 */

import { icon } from './ui.js';

const DECODER_SRC = 'vendor/ogg-vorbis-decoder.min.js';

let decoderScriptPromise = null;
let sharedContext = null;

/** 当前浏览器能不能直接播 Ogg Vorbis。 */
export function canPlayVorbisNatively() {
  return Boolean(document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"'));
}

function audioContext() {
  sharedContext ??= new (window.AudioContext || window.webkitAudioContext)();
  return sharedContext;
}

function loadDecoderScript() {
  decoderScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = DECODER_SRC;
    script.onload = resolve;
    script.onerror = () => reject(new Error('解码器加载失败'));
    document.head.append(script);
  });
  return decoderScriptPromise;
}

/**
 * 把 Ogg Vorbis 字节解成 AudioBuffer。三期上传时用同一条路解本地文件
 * （File 对象不走网络，也就不涉及 CORS）。
 * @param {ArrayBuffer|Uint8Array} data
 */
export async function decodeOggVorbis(data) {
  await loadDecoderScript();

  const factory = window['ogg-vorbis-decoder'];
  if (!factory) throw new Error('解码器未正确加载');

  const decoder = new factory.OggVorbisDecoder();
  try {
    await decoder.ready;
    const result = await decoder.decodeFile(
      data instanceof Uint8Array ? data : new Uint8Array(data));

    if (!result.samplesDecoded) throw new Error('音频解码结果为空');

    const context = audioContext();
    const buffer = context.createBuffer(
      result.channelData.length, result.samplesDecoded, result.sampleRate);
    result.channelData.forEach((channel, i) => buffer.copyToChannel(channel, i));
    return buffer;
  } finally {
    // 不 free 的话每放一次都会漏一份 wasm 堆
    decoder.free?.();
  }
}

/**
 * 造一个试听控件。
 *
 * 策略是"乐观 + 自愈"而不是只看 canPlayType：先挂原生 <audio>，出错再换成
 * WASM 播放器。因为已知有两种失败成因，只判断能力挡不住第二种——
 *
 * 1. Safari 根本不支持 Vorbis，canPlayType 返回空，能判出来；
 * 2. CDN 给这些文件返回的是 `audio/x-vorbis+ogg` 这个非标准 MIME
 *    （标准是 audio/ogg），对 MIME 严格的浏览器会认为自己能播、然后卡住——
 *    这种 canPlayType 是判不出来的。
 *
 * preload="metadata" 让错误在用户点播放之前就暴露，替换是无感的。
 *
 * @param {string} url 音频地址
 * @returns {HTMLElement} 容器元素
 */
export function createPreviewPlayer(url) {
  const container = document.createElement('div');
  container.className = 'preview-slot';

  if (!canPlayVorbisNatively()) {
    container.append(buildFallbackPlayer(url));
    return container;
  }

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = url;
  audio.addEventListener('error', () => {
    // 原生播不了——不管是编解码器还是 MIME 的问题，都退到 WASM 这条路
    audio.replaceWith(buildFallbackPlayer(url));
  }, { once: true });

  container.append(audio);
  return container;
}

// ---------- 不支持 Vorbis 时的自绘播放器 ----------

function buildFallbackPlayer(url) {
  const root = document.createElement('div');
  root.className = 'wa-player';
  root.innerHTML = `
    <button class="wa-play" type="button" aria-label="播放"></button>
    <div class="wa-track" role="slider" tabindex="0"
         aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="wa-fill"></div>
    </div>
    <span class="wa-time num">--:--</span>`;

  const playButton = root.querySelector('.wa-play');
  const track = root.querySelector('.wa-track');
  const fill = root.querySelector('.wa-fill');
  const time = root.querySelector('.wa-time');

  let buffer = null;
  let source = null;
  let playing = false;
  let offset = 0;         // 缓冲区内的播放位置（秒）
  let startedAt = 0;      // 开始播放时的 context 时间
  let raf = 0;

  const position = () => playing ? offset + (audioContext().currentTime - startedAt) : offset;

  function setIcon(name) {
    playButton.replaceChildren(icon(name, { solid: name === 'play' }));
  }
  setIcon('play');

  function setStatus(text, isError = false) {
    time.textContent = text;
    root.classList.toggle('is-error', isError);
  }

  function paint() {
    if (!buffer) return;
    const ratio = Math.min(1, position() / buffer.duration);
    fill.style.width = `${ratio * 100}%`;
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    time.textContent = `${clock(position())} / ${clock(buffer.duration)}`;

    if (playing) {
      if (position() >= buffer.duration) return stop(true);
      raf = requestAnimationFrame(paint);
    }
  }

  async function ensureBuffer() {
    if (buffer) return buffer;

    setStatus('加载中…');
    root.classList.add('is-loading');
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = await decodeOggVorbis(await response.arrayBuffer());
      return buffer;
    } catch (error) {
      // fetch 跨域失败时抛的是没有细节的 TypeError，这里是最可能出问题的地方：
      // <audio> 播跨域不需要 CORS，但读字节需要，CDN 没配就会走到这
      setStatus('无法读取', true);
      root.title = `试听加载失败：${error.message}`;
      throw error;
    } finally {
      root.classList.remove('is-loading');
    }
  }

  function start() {
    const context = audioContext();
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0, Math.min(offset, buffer.duration));
    startedAt = context.currentTime;
    playing = true;
    setIcon('pause');
    playButton.setAttribute('aria-label', '暂停');
    paint();
  }

  function stop(rewind = false) {
    if (source) {
      // 停一个已经自然播完的 source 会抛，这里不关心
      try { source.stop(); } catch {}
      source.disconnect();
      source = null;
    }
    if (playing) offset = rewind ? 0 : position();
    if (rewind) offset = 0;
    playing = false;
    cancelAnimationFrame(raf);
    setIcon('play');
    playButton.setAttribute('aria-label', '播放');
    if (buffer) paint();
  }

  playButton.addEventListener('click', async () => {
    if (playing) return stop();
    try {
      await ensureBuffer();
    } catch {
      return;   // 状态已经显示在控件上了
    }
    // 自动播放策略要求 AudioContext 在用户手势里恢复
    if (audioContext().state === 'suspended') await audioContext().resume();
    start();
  });

  function seekFromEvent(event) {
    if (!buffer) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const wasPlaying = playing;
    stop();
    offset = ratio * buffer.duration;
    if (wasPlaying) start(); else paint();
  }

  track.addEventListener('click', seekFromEvent);
  track.addEventListener('keydown', event => {
    if (!buffer) return;
    const step = event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0;
    if (!step) return;
    event.preventDefault();
    const wasPlaying = playing;
    stop();
    offset = Math.min(buffer.duration, Math.max(0, offset + step));
    if (wasPlaying) start(); else paint();
  });

  return root;
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

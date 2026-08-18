/**
 * 试听区间选择器：波形 + 双handle 拖选 + 就地试听。
 *
 * 上传流程本来就要把音频解成 AudioBuffer（生成预览片段用），所以画波形和试听
 * 都不额外花解码成本，把同一份 buffer 传进来即可。
 *
 * 后端对 preview 的硬约束是时长 ≤60 秒（LevelService 里超了直接 400），
 * 这里在交互上就卡死，不让用户拖出一个必然被拒的区间。
 */

import { PRESET, audioContext } from './media.js';

const MIN_SECONDS = 1;

/**
 * @param {object} options
 * @param {AudioBuffer} options.buffer
 * @param {number} [options.start] 初始起点（秒）
 * @param {number} [options.end]   初始终点（秒）
 * @param {(range: {start: number, end: number}) => void} [options.onChange]
 * @returns {{element: HTMLElement, setRange: Function, getRange: Function, destroy: Function}}
 */
export function createPreviewRangeEditor({ buffer, start = 0, end = 0, onChange }) {
  const duration = buffer.duration;
  const maxSeconds = Math.min(PRESET.preview.maxSeconds, duration);

  let range = clampRange(start, end, duration, maxSeconds);

  const root = document.createElement('div');
  root.className = 'range-editor';
  root.innerHTML = `
    <div class="range-canvas-wrap">
      <canvas class="range-canvas"></canvas>
      <div class="range-window">
        <div class="range-handle left" role="slider" tabindex="0" aria-label="试听起点"></div>
        <div class="range-handle right" role="slider" tabindex="0" aria-label="试听终点"></div>
      </div>
      <div class="range-playhead" hidden></div>
    </div>
    <div class="range-bar">
      <button class="button small range-play" type="button">试听选中片段</button>
      <span class="range-readout num"></span>
    </div>`;

  const wrap = root.querySelector('.range-canvas-wrap');
  const canvas = root.querySelector('.range-canvas');
  const windowEl = root.querySelector('.range-window');
  const playhead = root.querySelector('.range-playhead');
  const playButton = root.querySelector('.range-play');
  const readout = root.querySelector('.range-readout');

  // ---------- 波形 ----------

  let peaks = null;

  function computePeaks(columns) {
    // 取所有声道的绝对值峰值，单声道立体声都一样处理
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const perColumn = Math.max(1, Math.floor(buffer.length / columns));
    const result = new Float32Array(columns);

    for (let c = 0; c < columns; c += 1) {
      const from = c * perColumn;
      const to = Math.min(buffer.length, from + perColumn);
      let peak = 0;
      // 步进采样：整首歌逐样本扫一遍在长曲上会卡住主线程
      const step = Math.max(1, Math.floor((to - from) / 400));
      for (const data of channels) {
        for (let i = from; i < to; i += step) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
      }
      result[c] = peak;
    }
    return result;
  }

  function drawWaveform() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = wrap.clientWidth;
    const cssHeight = 96;
    if (!cssWidth) return;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = `${cssHeight}px`;

    const columns = Math.round(cssWidth);
    if (!peaks || peaks.length !== columns) peaks = computePeaks(columns);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const mid = cssHeight / 2;
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    for (let x = 0; x < columns; x += 1) {
      const h = Math.max(1, peaks[x] * (cssHeight - 8));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }

  // ---------- 区间 ----------

  function paint() {
    const left = (range.start / duration) * 100;
    const width = ((range.end - range.start) / duration) * 100;
    windowEl.style.left = `${left}%`;
    windowEl.style.width = `${width}%`;

    const length = range.end - range.start;
    readout.textContent = `${clock(range.start)} – ${clock(range.end)}（${length.toFixed(1)} 秒）`;
    readout.classList.toggle('at-limit', length >= maxSeconds - 0.05);

    for (const handle of root.querySelectorAll('.range-handle')) {
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', duration.toFixed(1));
    }
    root.querySelector('.range-handle.left').setAttribute('aria-valuenow', range.start.toFixed(1));
    root.querySelector('.range-handle.right').setAttribute('aria-valuenow', range.end.toFixed(1));
  }

  function commit(next, notify = true) {
    range = clampRange(next.start, next.end, duration, maxSeconds);
    paint();
    if (notify) onChange?.({ ...range });
  }

  const secondsAt = clientX => {
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  // ---------- 拖动 ----------

  let drag = null;

  wrap.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.range-handle');
    const at = secondsAt(event.clientX);

    if (handle) {
      drag = { mode: handle.classList.contains('left') ? 'start' : 'end' };
    } else if (event.target.closest('.range-window')) {
      drag = { mode: 'move', grabbedAt: at, from: { ...range } };
    } else {
      // 在空白处按下就是重新框选：按下点为起点，拖到哪儿就是终点
      drag = { mode: 'end' };
      commit({ start: at, end: at + MIN_SECONDS });
    }

    wrap.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  wrap.addEventListener('pointermove', event => {
    if (!drag) return;
    const at = secondsAt(event.clientX);

    if (drag.mode === 'start') {
      commit({ start: Math.min(at, range.end - MIN_SECONDS), end: range.end });
    } else if (drag.mode === 'end') {
      commit({ start: range.start, end: Math.max(at, range.start + MIN_SECONDS) });
    } else {
      const length = drag.from.end - drag.from.start;
      const offset = at - drag.grabbedAt;
      let start = Math.max(0, Math.min(drag.from.start + offset, duration - length));
      commit({ start, end: start + length });
    }
  });

  for (const type of ['pointerup', 'pointercancel']) {
    wrap.addEventListener(type, event => {
      drag = null;
      if (wrap.hasPointerCapture?.(event.pointerId)) wrap.releasePointerCapture(event.pointerId);
    });
  }

  // 键盘：左右微调 0.5 秒
  for (const handle of root.querySelectorAll('.range-handle')) {
    handle.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 0.5 : event.key === 'ArrowLeft' ? -0.5 : 0;
      if (!step) return;
      event.preventDefault();
      const isLeft = handle.classList.contains('left');
      commit(isLeft
        ? { start: range.start + step, end: range.end }
        : { start: range.start, end: range.end + step });
    });
  }

  // ---------- 试听 ----------

  let source = null;
  let raf = 0;

  function stopAudition() {
    if (source) {
      try { source.stop(); } catch {}
      source.disconnect();
      source = null;
    }
    cancelAnimationFrame(raf);
    playhead.hidden = true;
    playButton.textContent = '试听选中片段';
  }

  playButton.addEventListener('click', async () => {
    if (source) return stopAudition();

    const ctx = audioContext();
    // 自动播放策略要求在用户手势里恢复
    if (ctx.state === 'suspended') await ctx.resume();

    const length = range.end - range.start;
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { if (source) stopAudition(); };
    source.start(0, range.start, length);

    const startedAt = ctx.currentTime;
    playButton.textContent = '停止';
    playhead.hidden = false;

    const tick = () => {
      if (!source) return;
      const at = range.start + (ctx.currentTime - startedAt);
      playhead.style.left = `${(at / duration) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
  });

  // ---------- 生命周期 ----------

  const observer = new ResizeObserver(() => drawWaveform());
  observer.observe(wrap);

  requestAnimationFrame(() => { drawWaveform(); paint(); });

  return {
    element: root,
    getRange: () => ({ ...range }),
    setRange: (next, notify = false) => commit(next, notify),
    destroy: () => { stopAudition(); observer.disconnect(); },
  };
}

/** 夹到 [0, duration]，长度落在 [MIN_SECONDS, maxSeconds] 内。 */
function clampRange(start, end, duration, maxSeconds) {
  let s = Number.isFinite(start) ? start : 0;
  let e = Number.isFinite(end) ? end : 0;

  if (e <= s) e = s + Math.min(PRESET.preview.defaultSeconds, maxSeconds);

  s = Math.max(0, Math.min(s, Math.max(0, duration - MIN_SECONDS)));
  e = Math.min(e, duration, s + maxSeconds);
  if (e - s < MIN_SECONDS) e = Math.min(duration, s + MIN_SECONDS);

  return { start: s, end: e };
}

function clock(seconds) {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

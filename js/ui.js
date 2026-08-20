/** 页面共用的小工具：DOM 构建、格式化、错误展示。 */

/**
 * 建元素。属性走 setAttribute，文本走 textContent——
 * 谱面名、昵称、标签这些全是用户填的，一律不碰 innerHTML。
 *
 *   el('div', { class: 'card' }, el('h2', {}, '标题'), '正文')
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------- 格式化 ----------

/** 秒 → 3:42。时长为 0 的是历史遗留数据（服务端没实测出来），显示成 --:--。 */
export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '--:--';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/** 后端的 DateTime 是 UTC 但序列化后不带 Z，直接 new Date() 会被当本地时间。 */
export function parseUtc(value) {
  if (!value) return null;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = parseUtc(value);
  if (!date) return '';

  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;

  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 注销用户的昵称/头像不能用，统一换成占位文案（后端约定见 CLAUDE.md 的墓碑账号一节）。 */
export function displayName(nickname, isAnonymized) {
  return isAnonymized ? '已注销用户' : (nickname || '未知用户');
}

// ---------- 谱面主题色 ----------

const DEFAULT_THEME = '#4b65b0';

/**
 * themeColor 是上传者自己填的，会被写进内联 style，**必须校验**再用，
 * 否则就是一个 CSS 注入点。只放行 #RGB / #RRGGBB。
 */
export function safeThemeColor(value) {
  if (typeof value !== 'string') return DEFAULT_THEME;
  const hex = value.trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return DEFAULT_THEME;
  return hex;
}

/** 把主题色注入元素，下游 CSS 用 var(--theme) 取。 */
export function applyTheme(node, themeColor) {
  node.style.setProperty('--theme', safeThemeColor(themeColor));
}

// ---------- 封面 ----------

/**
 * 封面图。
 *
 * 用的是 LevelResponse.coverUrl 里的 LeanCloud 原始地址，不是后端那个 302 端点——
 * <img> 没法带 Authorization，走 302 端点必然 401。
 *
 * referrerpolicy="no-referrer" 是防着 CDN 的 Referer 防盗链：不发 Referer
 * 就绕过了绝大多数这类规则。真被拦下时 onerror 退化成主题色占位块，
 * 页面不会因为一张图崩掉。
 */
export function coverImage(level, { alt = '' } = {}) {
  const wrap = el('div', { class: 'cover' });
  applyTheme(wrap, level.themeColor);

  if (!level.coverUrl) {
    wrap.classList.add('cover-empty');
    return wrap;
  }

  const img = el('img', {
    src: level.coverUrl,
    alt,
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    onerror: () => {
      img.remove();
      wrap.classList.add('cover-empty');
    },
  });

  wrap.append(img);
  return wrap;
}

// ---------- 头像 ----------

/**
 * LeanCloud（七牛系）的图片处理参数。后端 AuthService.GetAvatarThumbnail 就是
 * 这么拼的，但只用在 /api/auth/profile 和 /api/auth/users/{id} 上；
 * LevelResponse.uploaderAvatarUrl 走的是 LevelMapper，给的是**原图地址**。
 * 谱面详情里只显示 40px，不缩一下等于每次都白下一张大图。
 */
function thumbnail(url, size) {
  if (!url) return url;
  return url.includes('?') ? url : `${url}?imageView/1/w/${size}/h/${size}`;
}

/**
 * 头像。没有图或图裂了就退化成昵称首字，比空框或占位图标干净。
 *
 * @param {?string} url
 * @param {string} name 已经过 displayName 处理的展示名
 * @param {{size?: number, className?: string}} [options] size 只用于请求缩略图，实际尺寸由 CSS 定
 */
export function avatarImage(url, name, { size = 128, className = 'avatar' } = {}) {
  const wrap = el('div', { class: className });

  if (!url) {
    wrap.classList.add('avatar-empty');
    wrap.textContent = (name || '?').slice(0, 1);
    return wrap;
  }

  const img = el('img', {
    src: thumbnail(url, size),
    alt: `${name} 的头像`,
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    onerror: () => {
      img.remove();
      wrap.classList.add('avatar-empty');
      wrap.textContent = (name || '?').slice(0, 1);
    },
  });
  wrap.append(img);
  return wrap;
}

// ---------- 命令块 ----------

/**
 * 可复制的命令行代码块。视频不合规时给出 ffmpeg 转码命令用。
 *
 * @param {string} command
 * @param {string} [note] 命令上方的一句说明
 */
export function commandBlock(command, note) {
  const code = el('code', {}, command);
  const copy = el('button', { class: 'button small', type: 'button' }, '复制');

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = '已复制';
    } catch {
      // 剪贴板要安全上下文和权限，失败时选中让用户自己复制
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copy.textContent = '请手动复制';
    }
    setTimeout(() => { copy.textContent = '复制'; }, 1600);
  });

  return el('div', { class: 'command-block' },
    note ? el('p', { class: 'command-note' }, note) : null,
    el('div', { class: 'command-line' }, el('pre', {}, code), copy),
  );
}

/**
 * 行内的"值 + 复制按钮"。比 commandBlock 轻，用于 UID 这类短值。
 *
 * @param {string} value
 * @param {{className?: string, label?: string}} [options]
 */
export function copyableValue(value, { className = '', label = '复制' } = {}) {
  const text = el('span', { class: 'copyable-value num' }, value);
  const button = el('button', { class: 'copyable-button', type: 'button', title: `复制${value}` }, label);

  button.addEventListener('click', async event => {
    // 这个组件常放在 <a> 里面（比如个人空间的卡片），别让点击冒泡上去触发跳转
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = '已复制';
    } catch {
      // 剪贴板要安全上下文和权限，失败时选中让用户自己复制
      const range = document.createRange();
      range.selectNodeContents(text);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      button.textContent = '请手动复制';
    }
    setTimeout(() => { button.textContent = label; }, 1600);
  });

  return el('span', { class: `copyable ${className}`.trim() }, text, button);
}

// ---------- 交互 ----------

/** 提交期间禁用按钮并转圈，结束后还原。 */
export async function withBusy(button, busyText, action) {
  const original = button.innerHTML;
  button.disabled = true;
  clear(button);
  button.append(el('span', { class: 'spinner' }), busyText);
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

export function showBox(node, message, kind) {
  if (kind) node.className = `callout ${kind}`;
  node.textContent = message;
  node.hidden = false;
}

export function hideBox(node) {
  node.hidden = true;
}

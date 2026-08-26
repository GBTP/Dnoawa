/**
 * 上传页和编辑页共用的资源槽位小组件。
 *
 * 组件只负责呈现选择/移除操作，不持有业务状态；调用方在 onChoose/onRemove 里更新 draft
 * 后调用 refresh()。这样本地上传和线上编辑可以共享手感而不共享错误的提交语义。
 */

import { el, clear } from './ui.js';

export function formatResourceSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function resourceFileName(value) {
  if (!value) return '';
  return value.name || value.file?.name || value.filename || '';
}

export function resourceFileSize(value) {
  if (!value) return '';
  // 三处都取不到时返回 NaN（"未知"），而不是 0（会被 formatResourceSize 显示成 "0 B"）。
  // 编辑页的「当前封面」这种占位值只有 name、没有字节来源，显示成 0 B 是错的。
  const size = value.size ?? value.file?.size ?? value.data?.length;
  return size ?? NaN;
}

/**
 * 造封面/背景图的预览 <img>。上传页和编辑页都用它，免得 class 和兜底逻辑写两遍。
 *
 * - cover：正方形（封面源图就是正方形），object-fit:cover 不裁内容
 * - background：4:3 示意框，object-fit:fill 故意把非 4:3 的图拉变形，
 *   让人一眼看出比例对不上
 *
 * 两页都加 onerror 文字兜底：本地 blob 不会裂，CDN URL 失效时换占位，
 * 不留一个坏掉的 img 图标。
 * @param {'cover'|'background'} kind
 * @param {string} url
 * @param {string} alt
 */
export function thumbImage(kind, url, alt) {
  const variant = kind === 'cover' ? 'resource-thumb--cover' : 'resource-thumb--bg';
  const img = el('img', { class: `resource-thumb ${variant}`, src: url, alt, referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', { class: `resource-thumb ${variant} resource-broken` }, '图片加载失败'));
  }, { once: true });
  return img;
}

export function createFilePicker({ accept = '', multiple = false, label = '选择文件', onFiles }) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  const button = el('button', { class: 'button small', type: 'button' }, label);
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    onFiles?.(files);
    input.value = '';
  });
  return { input, button, element: el('span', {}, button, input) };
}

/**
 * 创建一个标准资源行。
 * @param {{label: string, hint?: string, value?: any, required?: boolean, accept?: string,
 *   chooseLabel?: string, removeLabel?: string, onChoose?: (files: File[]) => void,
 *   onRemove?: () => void, extra?: Node|string, preview?: Node|string}} options
 */
export function createResourceRow(options) {
  const {
    label, hint = '', value = null, required = false, accept = '',
    chooseLabel = '选择文件', removeLabel = '移除', onChoose, onRemove,
    extra = null, preview = null,
  } = options;

  const row = el('div', { class: 'resource-row' });
  const current = el('span', { class: 'resource-file' });
  const choose = createFilePicker({ accept, label: chooseLabel, onFiles: onChoose });
  const remove = el('button', { class: 'button small ghost', type: 'button' }, removeLabel);
  const actions = el('div', { class: 'resource-actions' }, choose.button, current, remove, choose.input);
  const body = el('div', { class: 'resource-body' });
  const status = el('div', { class: 'resource-status' });
  const extraSlot = el('div', { class: 'resource-extra' });

  remove.addEventListener('click', () => onRemove?.());

  row.append(...[
    el('div', { class: 'resource-head' },
      el('strong', {}, required ? `${label}（必需）` : label),
      hint ? el('span', { class: 'resource-hint' }, hint) : null),
    preview ? el('div', { class: 'resource-preview' }, preview) : null,
    body,
    actions,
    status,
    extraSlot,
  ].filter(Boolean));

  function refresh(next = value, { message = '', error = false, done = false } = {}) {
    const name = resourceFileName(next);
    const size = formatResourceSize(resourceFileSize(next));
    current.textContent = name ? `${name}${size ? `（${size}）` : ''}` : (required ? '尚未选择' : '未提供');
    current.classList.toggle('is-empty', !name && required);
    remove.hidden = !next || !onRemove;
    status.textContent = message;
    status.className = `resource-status${error ? ' is-error' : ''}${done ? ' is-done' : ''}`;
    if (extra) {
      clear(extraSlot);
      if (typeof extra === 'function') extraSlot.append(extra(next));
      else if (extra) extraSlot.append(extra);
    }
  }

  refresh();
  return {
    element: row,
    body,
    current,
    status,
    extraSlot,
    chooseButton: choose.button,
    removeButton: remove,
    refresh,
  };
}

export function renderChangeSummary(items) {
  const values = items.filter(Boolean);
  if (!values.length) return '尚未选择改动';
  return values.join('、');
}

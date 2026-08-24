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
  return value.size ?? value.file?.size ?? value.data?.length ?? 0;
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

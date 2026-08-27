/**
 * 受控 tag 字典与 tag 相关的共享 UI。
 *
 * 后端契约（Bnoawa src/Bnoawa.Api/DTOs/Tags/TagDtos.cs、Controllers/TagsController.cs）：
 * - `GET /api/tags` 返回全量字典 `{ tags: [{id, categoryId, translations}],
 *   categories: [{id, translations}] }`，登录即可读。谱面上挂的是 `tagIds`（int 列表），
 *   展示时用这份字典按 id 解析出当前语言的翻译。
 * - **字典里没有内部 Name**：Name 是内部标识，不对外、不展示、不搜，展示和搜索都只走
 *   翻译。所以这里拿不到也不该拿 Name。
 *
 * 缓存策略对齐客户端 BnoawaManager.GetTagDictionaryAsync：10 分钟软 TTL，
 * 拉取失败用旧值兜底（可能是 null）。登出时清空（在 api.js 的 clearSession 里）——
 * 换线路不清：两条线指向同一个后端实例，字典不会分叉。
 */

import { get } from './api.js';
import { el, clear } from './ui.js';

const TAG_CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null;        // { tags: [], categories: [] } | null
let cacheExpiresAt = 0;  // 毫秒时间戳
let inflight = null;     // 进行中的拉取 Promise，并发的几个调用共用一发请求

/** 拉取 tag 字典。失败返回旧值（可能为 null），调用方必须判空。 */
export async function getTagDictionary(forceRefresh = false) {
  if (!forceRefresh && cache && Date.now() < cacheExpiresAt) return cache;
  if (inflight) return inflight;

  inflight = get('/api/tags')
    .then(dict => {
      cache = dict;
      cacheExpiresAt = Date.now() + TAG_CACHE_TTL_MS;
      return cache;
    })
    .catch(() => cache)   // 失败用旧值兜底，不刷新过期时间，下次还会重试
    .finally(() => { inflight = null; });

  return inflight;
}

/** 登出时清空。tag 字典是会话级缓存，不该带到下一个会话去。 */
export function clearTagDictionary() {
  cache = null;
  cacheExpiresAt = 0;
  inflight = null;
}

export function findTag(dict, id) {
  return dict?.tags?.find(t => t.id === id) ?? null;
}

export function findCategory(dict, id) {
  return dict?.categories?.find(c => c.id === id) ?? null;
}

/**
 * 取一个翻译表的展示名。回退链对齐客户端 BnoawaManager.GetLocalizedNameFromTranslations：
 * 当前语言（非空才算）→ zh-CN（回退基准，允许空）→ 第一个非空翻译 → `#id`。
 * 不走主站那套静态 key 的 L.Get——tag 名是动态服务端数据，不是界面文案。
 */
export function localizedName(translations, id) {
  const lang = (document.documentElement.lang || 'zh-CN').trim();
  if (translations?.[lang]) return translations[lang];
  if (translations && 'zh-CN' in translations) return translations['zh-CN'];
  for (const value of Object.values(translations ?? {})) {
    if (value) return value;
  }
  return `#${id}`;
}

export function tagName(dict, tag) {
  return localizedName(tag?.translations, tag?.id);
}

export function categoryName(dict, category) {
  return localizedName(category?.translations, category?.id);
}

/** 无类别那组的展示名。对齐客户端 chart_info.uncategorized / chart_library.uncategorized。 */
export const UNCATEGORIZED = '其它';

/**
 * 把 tag 列表按类别分组，无类别的归到 key = null 的「其它」组。
 * 组的出现顺序按字典里类别的顺序（后端按 Id 排序），其它组永远在最后。
 *
 * @returns {Array<{category: object|null, tags: object[]}>}
 */
export function groupByCategory(dict) {
  const byCategory = new Map();   // categoryId -> tags[]
  const noCategory = [];
  for (const tag of dict?.tags ?? []) {
    if (tag.categoryId != null) {
      if (!byCategory.has(tag.categoryId)) byCategory.set(tag.categoryId, []);
      byCategory.get(tag.categoryId).push(tag);
    } else {
      noCategory.push(tag);
    }
  }

  const groups = [];
  // 按字典里类别的顺序出组，保证和客户端看到的分组顺序一致
  for (const category of dict?.categories ?? []) {
    const tags = byCategory.get(category.id);
    if (tags?.length) groups.push({ category, tags });
  }
  if (noCategory.length) groups.push({ category: null, tags: noCategory });
  return groups;
}

// ---------- 共享 UI ----------

/**
 * 一个类别分组的 chip 墙。三处共用（编辑选择器、高级筛选、分类浏览），
 * 只是 chip 的点击行为和选中态类名不同。
 *
 * @param {object} dict
 * @param {object|null} category  null 表示「其它」组
 * @param {object[]} tags
 * @param {(tag: object, chip: HTMLButtonElement) => void} onToggle
 * @param {(tag: object) => string|null} [classOf]  额外类名（选中态等），null 表示无
 */
export function tagChipGroup(dict, category, tags, onToggle, classOf = () => null) {
  // 类名直接写全大写：.eyebrow 没有 text-transform，eyebrow 风格靠全大写文字本身
  const label = el('span', { class: 'tag-group-label eyebrow' },
    category ? categoryName(dict, category) : UNCATEGORIZED);
  const row = el('div', { class: 'tag-group-tags' });
  for (const tag of tags) {
    const chip = el('button', { class: 'tag-option', type: 'button' }, tagName(dict, tag));
    const extra = classOf(tag);
    if (extra) chip.classList.add(...extra.split(' '));
    chip.addEventListener('click', () => onToggle(tag, chip));
    row.append(chip);
  }
  return el('div', { class: 'tag-group' }, label, row);
}

/**
 * 受控 tag 选择器（上传/编辑用）：已选区（可取消 chip）+ 按类别分组的全部可选 chip。
 * 内部维护一个 Set，通过 getSelected() 把当前选中的 id 列表交出去。
 *
 * 字典为空（还没拉到 / 服务端没建 tag）时不显示选择器，只在已选区放一句提示——
 * 对齐客户端 LevelEditPanel 的 no_tags 行为。
 *
 * @param {number[]} initial  初始选中的 tag id
 * @param {{onChange?: (ids: number[]) => void}} [options]  每次选中变化后回调（刷摘要用）
 */
export function createTagPicker(initial = [], { onChange } = {}) {
  const selected = new Set(initial);
  const selectedRow = el('div', { class: 'tag-selected-row' });
  const picker = el('div', { class: 'tag-picker' });
  const element = el('div', { class: 'tag-select' }, selectedRow, picker);

  async function render() {
    clear(selectedRow);
    clear(picker);

    const dict = await getTagDictionary();
    if (!dict?.tags?.length) {
      selectedRow.append(el('span', { class: 'tag-hint' },
        '暂无可选标签（管理员尚未建立标签字典）'));
      return;
    }

    for (const id of selected) {
      const tag = findTag(dict, id);
      // 字典里找不到的（可能已被管理员删掉/合并）不渲染成可取消 chip，直接丢掉
      if (!tag) continue;
      const item = el('span', { class: 'tag-chip' },
        tagName(dict, tag),
        el('button', {
          class: 'tag-chip-remove', type: 'button', 'aria-label': `移除 ${tagName(dict, tag)}`,
          onclick: () => { selected.delete(id); render(); onChange?.(getSelected()); },
        }, '×'));
      selectedRow.append(item);
    }

    for (const { category, tags } of groupByCategory(dict)) {
      picker.append(tagChipGroup(dict, category, tags,
        tag => {
          if (selected.has(tag.id)) selected.delete(tag.id);
          else selected.add(tag.id);
          render();
          onChange?.(getSelected());
        },
        tag => (selected.has(tag.id) ? 'is-on' : null)));
    }
  }

  function getSelected() {
    return [...selected];
  }

  render();
  return { element, getSelected };
}

/**
 * 搜索关键词编辑器（上传/编辑用）：输入框 + 「+」按钮 + 已选关键词的可取消 chip。
 * keyword 不展示给别人、仅搜索（后端 LevelResponse.keywords 仅 owner/admin 可见），
 * 所以这是唯一维护它们的入口。
 *
 * @param {string[]} initial
 * @param {{onChange?: (keywords: string[]) => void}} [options]
 */
export function createKeywordEditor(initial = [], { onChange } = {}) {
  const keywords = [...initial];
  const display = el('div', { class: 'tag-selected-row' });
  const input = el('input', {
    class: 'input', maxlength: '40', autocomplete: 'off',
    placeholder: '搜索关键词，回车或点 + 添加',
  });
  const add = el('button', { class: 'button small', type: 'button' }, '+');
  const element = el('div', { class: 'keyword-editor' },
    display,
    el('div', { class: 'keyword-input-row' }, input, add));

  function render() {
    clear(display);
    for (const kw of keywords) {
      display.append(el('span', { class: 'tag-chip' },
        kw,
        el('button', {
          class: 'tag-chip-remove', type: 'button', 'aria-label': `移除 ${kw}`,
          onclick: () => { keywords.splice(keywords.indexOf(kw), 1); render(); onChange?.(getKeywords()); },
        }, '×')));
    }
  }

  function addKeyword() {
    const kw = input.value.trim();
    if (!kw) return;
    if (!keywords.includes(kw)) keywords.push(kw);
    input.value = '';
    render();
    onChange?.(getKeywords());
  }

  add.addEventListener('click', addKeyword);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addKeyword(); }
  });

  function getKeywords() {
    return [...keywords];
  }

  render();
  return { element, getKeywords, input };
}

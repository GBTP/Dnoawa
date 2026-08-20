/**
 * 谱面卡片。谱面库和个人空间共用，两边的卡片必须长得一样。
 */

import { el, coverImage, applyTheme, formatCount, formatDuration } from './ui.js';
import { difficultyTier } from './songlist.js';
import { STATUS_LABELS } from './levels.js';

/**
 * @param {object} level LevelResponse
 * @returns {HTMLAnchorElement}
 */
export function levelCard(level) {
  const card = el('a', {
    class: 'level-card',
    href: `level.html?id=${encodeURIComponent(level.id)}`,
  });
  applyTheme(card, level.themeColor);

  const cover = coverImage(level, { alt: `${level.levelName} 封面` });

  if (level.displayDifficulty) {
    // 认得出难度档就用该档的固定色（与客户端 DiffColors 同一套），
    // 认不出时回落到谱面自己的 themeColor
    const tier = difficultyTier(level.displayDifficulty);
    cover.append(el('span', {
      class: 'diff-badge',
      dataset: tier >= 0 ? { tier: String(tier) } : {},
    }, level.displayDifficulty));
  }

  // 非 Approved 的只可能出现在自己的列表里——别人的谱面后端只发 Approved
  if (level.status && level.status !== 'Approved') {
    cover.append(el('span', {
      class: `status-badge ${level.status.toLowerCase()}`,
    }, STATUS_LABELS[level.status] || level.status));
  }

  card.append(
    cover,
    el('div', { class: 'level-accent' }),
    el('div', { class: 'level-meta' },
      el('h3', { class: 'level-title' }, level.levelName),
      el('p', { class: 'level-sub' }, level.composerName),
      el('p', { class: 'level-sub' }, `谱面 ${level.charterName}`),
    ),
    el('div', { class: 'level-foot' },
      el('span', { class: 'stat', title: '游玩次数' }, '▶', el('span', { class: 'num' }, formatCount(level.playCount))),
      el('span', { class: 'stat', title: '点赞数' }, '♥', el('span', { class: 'num' }, formatCount(level.likeCount))),
      el('span', { class: 'stat num', style: 'margin-left:auto', title: '时长' }, formatDuration(level.durationSeconds)),
    ),
  );
  return card;
}

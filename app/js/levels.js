/**
 * 谱面与排行榜接口。
 *
 * 权限（后端 LevelService）：普通用户只看得到 Approved 的谱面，加上自己那些
 * Pending 的；管理员看全部。所以列表里出现 status !== 'Approved' 的条目，
 * 只可能是当前用户自己上传的。
 */

import { get, post } from './api.js';

/** PaginateAsync 把 pageSize clamp 到 1–50，前端别发更大的值。 */
export const MAX_PAGE_SIZE = 50;

/** 后端 PaginateAsync 认得的排序字段，其余值会落到默认的 created。 */
export const SORT_OPTIONS = [
  { value: 'created', label: '最新上传' },
  { value: 'playCount', label: '游玩次数' },
  { value: 'likeCount', label: '点赞数' },
  { value: 'updated', label: '最近更新' },
  { value: 'duration', label: '时长' },
  { value: 'bpm', label: 'BPM' },
  { value: 'name', label: '名称' },
];

/**
 * 谱面列表。搜索会匹配曲名/曲师/谱师/画师/标签。
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function listLevels({ search = '', page = 1, pageSize = 24, sortBy = 'created', sortOrder = 'desc' } = {}) {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(Math.min(pageSize, MAX_PAGE_SIZE)),
    sortBy,
    sortOrder,
  });
  if (search.trim()) query.set('search', search.trim());
  return get(`/api/levels?${query}`);
}

/**
 * 单张谱面。
 * 404 = 真的没了，可以清本地关联；403 = 存在但当前不可见（比如别人审核中的谱面），
 * 不能当成已删除。调用方用 error.isGone 区分。
 */
export function getLevel(id) {
  return get(`/api/levels/${id}`);
}

/** 我上传的谱面（含审核中的）。 */
export function listMyLevels({ page = 1, pageSize = 24 } = {}) {
  return get(`/api/levels/mine?page=${page}&pageSize=${Math.min(pageSize, MAX_PAGE_SIZE)}`);
}

/** 切换点赞，返回切换后的状态。 */
export function toggleLike(id) {
  return post(`/api/levels/${id}/like`);
}

/** 单张谱面的排行榜（每人只有最佳成绩）。 */
export function getLeaderboard(id, { page = 1, pageSize = 20 } = {}) {
  return get(`/api/levels/${id}/leaderboard?page=${page}&pageSize=${pageSize}`);
}

/** 热门榜，固定返回 Top 50，不接受条数参数。 */
export function getHotLevels(period = 'week') {
  return get(`/api/leaderboard/hot?period=${period}`);
}

/** ComboState → 展示文案。取值见 ScoreService.SubmitScoreAsync。 */
export const COMBO_LABELS = {
  PureMemory: 'Pure Memory',
  FullRecall: 'Full Recall',
  TrackComplete: 'Track Complete',
};

/** 谱面审核状态 → 展示文案。 */
export const STATUS_LABELS = {
  Approved: '已通过',
  Pending: '审核中',
  Rejected: '已拒绝',
};

/**
 * 谱面与排行榜接口。
 *
 * 权限（后端 LevelService）：普通用户只看得到 Approved 的谱面，加上自己那些
 * Pending 的；管理员看全部。所以列表里出现 status !== 'Approved' 的条目，
 * 只可能是当前用户自己上传的。
 */

import { get, post, put, del } from './api.js';

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

/** 与客户端和后端默认一致的每页条数。 */
export const PAGE_SIZE = 20;

/**
 * 谱面列表。搜索会匹配曲名/曲师/谱师/画师/标签。
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function listLevels({ search = '', page = 1, pageSize = PAGE_SIZE, sortBy = 'created', sortOrder = 'desc' } = {}) {
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
export function listMyLevels({ page = 1, pageSize = PAGE_SIZE } = {}) {
  return get(`/api/levels/mine?page=${page}&pageSize=${Math.min(pageSize, MAX_PAGE_SIZE)}`);
}

/**
 * 更新谱面。只传要改的字段，null/undefined 的字段后端不动。
 *
 * 重要：**非管理员改完后 Status 会被后端重置为 Pending，需要重新审核**
 * （LevelService.UpdateLevelAsync 末尾的 `if (!isAdmin) level.Status = Pending`）。
 * 界面上必须讲清楚，否则谱师会以为改个错别字就把自己的谱面从库里弄消失了。
 *
 * durationSeconds 单独提交会 400——它只能跟 musicFileId 一起，
 * 而且写库的永远是服务端实测值。网页端不碰这个字段。
 */
export function updateLevel(id, patch) {
  return put(`/api/levels/${id}`, patch);
}

/** 删除谱面。上传者或管理员可用，会连带删掉云存储文件和所有人的成绩点赞。 */
export function deleteLevel(id) {
  return del(`/api/levels/${id}`);
}

/** 切换点赞，返回切换后的状态。 */
export function toggleLike(id) {
  return post(`/api/levels/${id}/like`);
}

/** 单张谱面的排行榜（每人只有最佳成绩）。 */
export function getLeaderboard(id, { page = 1, pageSize = 20 } = {}) {
  return get(`/api/levels/${id}/leaderboard?page=${page}&pageSize=${pageSize}`);
}

/** 后端 HotLeaderboardCache.NormalizePeriod 认得的三个周期。 */
export const HOT_PERIODS = [
  { value: 'day', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
];

/**
 * 热门榜。**固定返回 Top 50，端点不接受条数参数**（老客户端传 ?count= 会被忽略）。
 *
 * 热度 = 周期内游玩次数 × clamp(时长, 30, 240)，长曲的一次游玩权重更高，
 * 但时长因子只在 30–240 秒区间内线性生效。
 *
 * 返回 { period, items: [{ level, playCount }] }。注意 item.playCount 是**周期内**
 * 的次数，和嵌套的 level.playCount（历史累计）不是一回事，展示时别混。
 */
export function getHotLevels(period = 'week') {
  return get(`/api/leaderboard/hot?period=${encodeURIComponent(period)}`);
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

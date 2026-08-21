/**
 * 用户资料与个人空间。
 *
 * 自己和别人走的是两套端点，返回的东西也不一样：
 *   自己  GET /api/auth/profile      带邮箱和 isAdmin
 *         GET /api/levels/mine       **含审核中的谱面**
 *   别人  GET /api/auth/users/{id}   只有公开字段，带 isAnonymized
 *         GET /api/users/{id}/levels **只有已通过的**（LevelService 里写死了 Approved 过滤）
 *
 * 这个差异是刻意的：审核中的作品只该给作者本人看见。
 */

import { get, put } from './api.js';
import { MAX_PAGE_SIZE, PAGE_SIZE } from './levels.js';

/** 当前登录用户的完整资料。 */
export function getMyProfile() {
  return get('/api/auth/profile');
}

/** 别人的公开资料。isAnonymized 为 true 时昵称和头像都不能用。 */
export function getPublicUser(id) {
  return get(`/api/auth/users/${id}`);
}

/**
 * 按昵称找人，邀请挂名时的选人控件用。返回的是数组**不是分页包装**——它是选人控件不是列表。
 *
 * **昵称不唯一**，所以界面上必须把每条的 id（UID）显示出来让用户自己确认；后端收的也仍然是
 * UID，这个接口只是免去"先问对方要 UID"这一步。
 *
 * 关键词少于 2 个字符后端会 400，调用方自己先挡一下，别为必然失败的请求占限流额度
 * （这个端点有独立的限流桶，30 次/分钟）。
 *
 * @param {string} q
 * @param {{limit?: number}} [options] 1–20，后端会夹紧
 * @returns {Promise<Array<{id: number, nickname: string, avatarUrl: ?string}>>}
 */
export function searchUsers(q, { limit = 10 } = {}) {
  return get(`/api/auth/users/search?q=${encodeURIComponent(q.trim())}&limit=${limit}`);
}

/** 昵称搜索的最短关键词，和后端 AuthService.MinSearchLength 一致。 */
export const MIN_SEARCH_LENGTH = 2;

/**
 * 更新自己的资料。三个字段都可选，只传要改的。
 * @param {{nickname?: string, bilibiliUid?: string, avatarFileId?: string}} patch
 */
export function updateProfile(patch) {
  return put('/api/auth/profile', patch);
}

/** 我上传的谱面，含审核中的。 */
export function getMyLevels({ page = 1, pageSize = PAGE_SIZE } = {}) {
  return get(`/api/levels/mine?page=${page}&pageSize=${Math.min(pageSize, MAX_PAGE_SIZE)}`);
}

/** 某人上传的谱面，只有已通过审核的。 */
export function getUserLevels(id, { page = 1, pageSize = PAGE_SIZE } = {}) {
  return get(`/api/users/${id}/levels?page=${page}&pageSize=${Math.min(pageSize, MAX_PAGE_SIZE)}`);
}

/**
 * 最近游玩记录。
 * @param {?number} userId 传 null 取自己的
 */
export function getRecentPlays(userId, { count = 20 } = {}) {
  return userId === null
    ? get(`/api/scores/recent?count=${count}`)
    : get(`/api/users/${userId}/scores/recent?count=${count}`);
}

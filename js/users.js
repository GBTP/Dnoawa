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

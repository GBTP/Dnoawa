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
  { value: 'updated', label: '最近更新' },
  { value: 'playCount', label: '游玩次数' },
  { value: 'downloadCount', label: '下载数' },
  { value: 'likeCount', label: '点赞数' },
  { value: 'whatCount', label: '何意味数' },
  { value: 'dislikeCount', label: '踩数' },
  { value: 'duration', label: '时长最长' },
  { value: 'chartConstant', label: '难度最高' },
  { value: 'bpm', label: 'BPM 最高' },
];

/** 与客户端和后端默认一致的每页条数。 */
export const PAGE_SIZE = 20;

/**
 * 谱面列表。搜索会匹配曲名/曲师/谱师/画师/简介，以及 tag 翻译和搜索关键词。
 *
 * tag 筛选对齐客户端 SDK 的 GetLevelsAsync：
 * - `tagIds` / `excludeTagIds` 拼成 csv（如 "5,6"），包含=AND（同时命中所有），
 *   排除=NOT（命中任一即滤掉）。空数组不传该参数。
 * - 定数/时长是开区间下限、含上限；ChartConstant 为 null 的谱面不会被定数范围命中。
 *
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function listLevels({
  search = '', page = 1, pageSize = PAGE_SIZE, sortBy = 'created', sortOrder = 'desc',
  tagIds = null, excludeTagIds = null,
  minChartConstant = null, maxChartConstant = null,
  minDuration = null, maxDuration = null,
} = {}) {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(Math.min(pageSize, MAX_PAGE_SIZE)),
    sortBy,
    sortOrder,
  });
  if (search.trim()) query.set('search', search.trim());
  // int 不需转义，直接 join
  if (tagIds?.length) query.set('tagId', tagIds.join(','));
  if (excludeTagIds?.length) query.set('excludeTagId', excludeTagIds.join(','));
  if (minChartConstant != null) query.set('minChartConstant', String(minChartConstant));
  if (maxChartConstant != null) query.set('maxChartConstant', String(maxChartConstant));
  if (minDuration != null) query.set('minDuration', String(minDuration));
  if (maxDuration != null) query.set('maxDuration', String(maxDuration));
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
 * removeVideo 是显式清空 BGA 的开关，缺省不修改；不要用 videoFileId: null 代替。
 */
export function updateLevel(id, patch) {
  return put(`/api/levels/${id}`, patch);
}

/**
 * 删除谱面。**需要 accountToken**（先 elevate），因为这是不可逆操作——
 * 云文件一起毁。后端把它和生成转让码一起挪进了 LevelOwnershipController，
 * 整个类要求 AccountPolicy，规则是"不可逆的事都要提权"。
 *
 * 归属判定看的是账号而不是当前身份：名下任何小号的谱面都归他管，
 * 不需要先切换到那个身份。
 */
export function deleteLevel(id) {
  return del(`/api/levels/${id}`, { account: true });
}

// ---------- 合作者挂名 ----------
//
// **纯署名，没有任何编辑权限。** 挂名不等于共同所有——所有权仍然只在上传者
// 手上，要交出去得用下面的转让。
//
// LevelResponse.collaborators **只在谱面详情里填充**，列表、随机和热榜恒为空
// 数组（后端刻意如此：为一个只在详情页展示的名单给列表加查询是浪费）。
// 所以卡片上不要试图渲染它。

/** 邀请一个身份挂名。对方确认后才会出现在署名里。 */
export function inviteCollaborator(levelId, profileId, role) {
  return post(`/api/levels/${levelId}/collaborators`, {
    profileId: Number(profileId),
    role: role.trim(),
  });
}

/** 改某个合作者的分工标签。 */
export function updateCollaboratorRole(levelId, profileId, role) {
  return put(`/api/levels/${levelId}/collaborators/${profileId}`, { role: role.trim() });
}

/** 移除合作者（待确认的邀请也用这个撤回）。 */
export function removeCollaborator(levelId, profileId) {
  return del(`/api/levels/${levelId}/collaborators/${profileId}`);
}

/** 接受挂名邀请。 */
export function acceptCollaboration(levelId) {
  return post(`/api/levels/${levelId}/collaborators/accept`);
}

/**
 * 我收到的、还没确认的挂名邀请。分页包装，空时是
 * { items: [], totalCount: 0, ... } 而不是 null 或裸数组。
 *
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function getPendingCollaborations({ page = 1, pageSize = 20 } = {}) {
  return get(`/api/levels/collaborations/pending?page=${page}&pageSize=${pageSize}`);
}

/**
 * 我名下谱面上还没被确认的邀请，也就是上面那个的另一面。
 *
 * 口径是**谱面主人**而不是当初的邀请人：撤回的资格看的是主人，所以列出来的每一条都撤得掉。
 * 代价是接手过来的谱面上、前主人留下的悬挂邀请也在这个列表里（转让只改归属，不清理待确认
 * 邀请），响应里的 `invitedByNickname` 就是给这种情况看的——别默认每条都是自己发的。
 *
 * 撤回直接用 removeCollaborator(levelId, inviteeProfileId)，没有单独的端点。
 *
 * @returns {Promise<{items: object[], totalCount: number, page: number, pageSize: number}>}
 */
export function getSentCollaborations({ page = 1, pageSize = 20 } = {}) {
  return get(`/api/levels/collaborations/sent?page=${page}&pageSize=${pageSize}`);
}

// ---------- 谱面所有权转让 ----------
//
// 用于多人合作时在成员之间移交谱面，也用于代传后把作品交还作者。
// **这些端点收 profileToken**（谱面归属是身份维度的游戏内操作），
// 不像身份转让那样需要 accountToken。

/**
 * 生成一次性转让码。**需要 accountToken**（先 elevate）——把归属送走同样是
 * 不可逆的，和删除归在一起。
 *
 * **明文只在这次响应里出现**，库里存的是 SHA-256，任何接口都取不回来。
 * 重复调用会作废上一个未领取的码——否则先后发出去的两张码都能兑换，
 * 发起方以为撤销了其实没有。
 *
 * 注意撤销（revokeLevelTransfer）仍在 LevelsController 里、收 profileToken：
 * 撤销是可逆方向的操作，不需要提权。
 *
 * @returns {Promise<{code: string, expiresAtUtc: string}>}
 */
export function createLevelTransfer(id) {
  return post(`/api/levels/${id}/transfer`, undefined, { account: true });
}

/** 撤销未被领取的转让码。 */
export function revokeLevelTransfer(id) {
  return del(`/api/levels/${id}/transfer`);
}

/**
 * 凭码查看要接手的是哪张谱面，**不改变任何状态**。
 * 拿到一串码的人不该只能盲领，界面上必须先预览再确认。
 * @returns {Promise<object>} LevelResponse
 */
export function previewLevelTransfer(code) {
  return get(`/api/levels/transfer?code=${encodeURIComponent(code.trim())}`);
}

/**
 * 凭码接手谱面。**成功后原主人对它的编辑/删除权限立即消失。**
 * @returns {Promise<object>} LevelResponse
 */
export function claimLevelTransfer(code) {
  return post('/api/levels/claim', { code: code.trim() });
}

/** 切换点赞，返回切换后的状态。旧端点，保留兼容。 */
export function toggleLike(id) {
  return post(`/api/levels/${id}/like`);
}

/**
 * 设置评价（Like / What / Dislike）。同值再发 = 取消，不同值 = 切换。
 * 必须游玩过该谱面才能评价，否则服务端返 403。
 * @param {'Like'|'What'|'Dislike'} type
 * @returns {Promise<{myFeedback: string|null, likeCount: number, whatCount: number, dislikeCount: number}>}
 */
export function setFeedback(id, type) {
  return post(`/api/levels/${id}/feedback`, { type });
}

/** 客户端 LeaderboardPanel 请求的条数，两端保持一致。 */
export const LEADERBOARD_SIZE = 100;

/** 单张谱面的排行榜（每人只有最佳成绩）。 */
export function getLeaderboard(id, { page = 1, pageSize = LEADERBOARD_SIZE } = {}) {
  return get(`/api/levels/${id}/leaderboard?page=${page}&pageSize=${pageSize}`);
}

/**
 * 我附近的排名。range 被后端 clamp 到 10–200，返回以我为中心的一段。
 *
 * **没有成绩时返回 { myRank: 0, myScore: null, items: [] }**，不是 404——
 * 调用方要按 myRank === 0 判断，别拿 items.length 当依据。
 */
export function getAroundMe(id, { range = LEADERBOARD_SIZE } = {}) {
  return get(`/api/levels/${id}/leaderboard/around-me?range=${range}`);
}

/** 我在这张谱面上的最好成绩。**没打过返回 null 而不是 404。** */
export function getMyBest(id) {
  return get(`/api/levels/${id}/my-best`);
}

/**
 * 成绩-定数趋势曲线（后端预聚合）。只统计 800W 以上、且投过定数票的玩家；
 * 按 1W 分档，档内取定数中位数，不设每档最少人数——单人档也保留。
 * 仅网页端消费，Unity 客户端不调用。
 *
 * @returns {Promise<{points: {scoreStart:number, scoreEnd:number, median:number, playerCount:number}[], minScore:number, maxScore:number}>}
 */
export function getRatingCurve(id) {
  return get(`/api/levels/${id}/rating-curve`);
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

/**
 * 用户数据（身份）管理。
 *
 * 一个账号可以有多个身份，既为了开小号，也为了代传谱面——帮别人上传时单独建
 * 一个身份来传，作者本人注册后把整个身份转让给他。
 *
 * **这些端点全部收 accountToken，不是 profileToken。** 后端用授权策略强制两者
 * 互斥，拿错了是 403 而不是静默降级。accountToken 只放内存（见 api.js 的说明），
 * 过期后要重新 elevate。
 */

import { post, del, request, setAccountToken, hasAccountToken } from './api.js';

/**
 * 用密码把当前会话提权成账号级，拿到 accountToken（1 小时，只放内存）。
 *
 * redirectOnUnauthorized: false —— 这里的 401 是"密码错了"，
 * 不是"会话过期"，交给调用方显示错误，不能跳转把提示冲掉。
 */
export async function elevate(password) {
  const result = await post('/api/auth/elevate', { password }, {
    redirectOnUnauthorized: false,
  });
  setAccountToken(result.accountToken);
  return result;
}

/** 已经有 accountToken 就直接用，没有则要求调用方先 elevate。 */
export function needsElevate() {
  return !hasAccountToken();
}

/**
 * 名下全部身份。
 * @returns {Promise<{items: object[], maxPerAccount: number, lastProfileId: ?number}>}
 */
export function listProfiles() {
  return request('/api/profiles', { account: true });
}

/** 新建一个身份。达到 maxPerAccount 上限时后端会 400。 */
export function createProfile(nickname) {
  return post('/api/profiles', { nickname: nickname.trim() }, { account: true });
}

/**
 * 切换到某个身份，换一张新的 profileToken。
 * 拿到后要落盘替换旧的，否则后续请求还是以原身份发出。
 */
export function issueProfileToken(profileId) {
  return post(`/api/profiles/${profileId}/token`, undefined, { account: true });
}

/**
 * 删除一个身份。
 *
 * 两个开关与注销账号完全同义，**同样缺字段即 true（全删）**，所以这里一律显式发送。
 * 保留的数据会改挂到墓碑（AccountId 为空的身份行），在社区里显示成"已注销用户"。
 * 评价（点赞三态、体感难度票）跟随 deletePlayRecords——它们都需游玩过才能提交。
 */
export function deleteProfile(profileId, scope) {
  return request(`/api/profiles/${profileId}`, {
    method: 'DELETE',
    account: true,
    body: {
      deleteLevels: Boolean(scope.deleteLevels),
      deletePlayRecords: Boolean(scope.deletePlayRecords),
    },
  });
}

/**
 * 生成转让码。**明文只在这次响应里出现一次**，库里存的是 SHA-256，
 * 之后再列身份只能看到 hasPendingTransfer 和过期时间。
 */
export function createTransfer(profileId) {
  return post(`/api/profiles/${profileId}/transfer`, undefined, { account: true });
}

/** 撤销未被领取的转让码。 */
export function revokeTransfer(profileId) {
  return del(`/api/profiles/${profileId}/transfer`, { account: true });
}

/** 用转让码把别人的身份领到自己账号下。 */
export function claimTransfer(code) {
  return post('/api/profiles/claim', { code: code.trim() }, { account: true });
}

/**
 * 账号相关接口。
 *
 * 注册流程和常见的"填密码注册"不一样（见 Bnoawa/Services/AuthService.cs:33-90）：
 * 提交邮箱 → 后端生成随机初始密码发信 → **30 分钟内**首次登录才算注册完成。
 * 逾期未登录的账号会被 ExpiredRegistrationCleanupService 删掉，得重新注册。
 * 这个时间窗必须在界面上讲清楚，否则用户注册完关掉页面就白注册了。
 */

import { post, get, saveSession } from './api.js';

/** 后端 ChangePasswordRequest.NewPassword 上是 [MinLength(8)]，前端先挡一道。 */
export const MIN_PASSWORD_LENGTH = 8;

/** 首次登录后引导改密码用的标记：注册成功时写入，改完密码或跳过后清掉。 */
const PENDING_KEY = 'anoawa.pendingFirstLogin';

export function markPendingFirstLogin(email) {
  localStorage.setItem(PENDING_KEY, email.trim().toLowerCase());
}

export function getPendingFirstLogin() {
  return localStorage.getItem(PENDING_KEY);
}

export function clearPendingFirstLogin() {
  localStorage.removeItem(PENDING_KEY);
}

/**
 * 申请注册。成功只代表信发出去了，账号这时还是未确认状态。
 * @returns {Promise<string>} 后端给的提示文案
 */
export async function register(email) {
  const result = await post('/api/auth/register', { email: email.trim() }, {
    auth: false,
  });
  return result?.message || '初始密码已发送到你的邮箱，请在 30 分钟内登录';
}

/**
 * 登录。首次登录会把账号置为已确认，也就是注册的最后一步。
 * redirectOnUnauthorized: false —— 这里的 401 是"密码错了"，
 * 不是"会话过期"，交给页面显示错误，不能跳转把提示冲掉。
 */
export async function login(email, password) {
  const result = await post('/api/auth/login', { email: email.trim(), password }, {
    auth: false,
    redirectOnUnauthorized: false,
  });

  saveSession(result.token, {
    nickname: result.nickname,
    avatarUrl: result.avatarUrl,
  });
  return result;
}

/** 请求改密码用的邮箱验证码，10 分钟有效。 */
export async function requestVerificationCode(email) {
  await post('/api/auth/request-verification-code', { email: email.trim() }, { auth: false });
}

/**
 * 用验证码改密码。改完后端会自增 TokenVersion，
 * 该账号此前签发的所有 token 立即失效（包括本页面手上这张）。
 */
export async function changePassword(email, verificationCode, newPassword) {
  await post('/api/auth/change-password', {
    email: email.trim(),
    verificationCode: verificationCode.trim(),
    newPassword,
  }, { auth: false });
}

/** 当前登录用户的完整资料。 */
export function fetchProfile() {
  return get('/api/auth/profile');
}

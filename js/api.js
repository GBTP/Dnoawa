/**
 * Bnoawa API 客户端。
 *
 * 后端约定（见 Bnoawa/CLAUDE.md 的 HTTP 状态码规范）：
 * - 所有错误响应都是 { "message": "..." }，直接拿来显示给用户
 * - 401 = 凭据无效/过期；403 = 资源存在但当前不可见；404 才是真的没了
 * - 429 带 Retry-After 秒数
 *
 * 打哪条线由 endpoint.js 决定（两个域名指向同一个后端实例），本机 ?api= 覆盖也搬去了
 * 那里。这里只负责在请求失败时按 endpoint.js 的判据决定重试还是抛出。
 */

import {
  getApiBase, resolveFailure, scheduleProbe, fetchWithTimeout, isEdgeFailure,
} from './endpoint.js';

const TOKEN_KEY = 'anoawa.token';
const PROFILE_KEY = 'anoawa.profile';
const LOGIN_PAGE = 'login.html';

/**
 * 单个请求的超时。为什么非有不可见 endpoint.js 的 fetchWithTimeout。
 *
 * 12 秒的取法：既要盖得住慢网下的正常请求，又要短到用户还没决定刷新页面。
 * tus 分片不走这里，它在 tus.js 里有自己的超时（1MB 在慢上行链路上会超过 12 秒）。
 */
const REQUEST_TIMEOUT_MS = 12_000;

/** 链路没坏、但这一发失败了的时候，只有这些方法能原地重试。理由见 canRetry。 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

const MAX_WRITE_LOCK_RETRIES = 2;
const MAX_WRITE_LOCK_BACKOFF_MS = 3000;

/**
 * accountToken **只放内存，绝不落盘**。
 *
 * 后端把它和 profileToken 分成两张，理由是隐私而不是权限：账号级端点的每个响应
 * 都在回答"这个账号名下有哪些身份"，那正是多个小号之间唯一可关联的信息。
 * profileToken 常驻 localStorage 七天，被 XSS 读走只暴露那一个身份；
 * accountToken 一旦也落盘，小号之间的关联就跟着泄露了。
 *
 * 代价是刷新页面后要重新 elevate（输一次密码）。这和客户端的处理一致。
 */
let accountToken = null;

/** 请求失败。status 为 0 表示请求根本没到服务器（断网 / 被 CORS 拦下）。 */
export class ApiError extends Error {
  constructor(message, status = 0, retryAfterSeconds = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** 资源确实不存在，可以清掉本地关联。403 不算——那只是暂时看不到。 */
  get isGone() {
    return this.status === 404;
  }
}

// ---------- 会话 ----------

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/** 当前内存里的 accountToken，没有则为 null。 */
export function getAccountToken() {
  return accountToken;
}

export function hasAccountToken() {
  return Boolean(accountToken);
}

/** 登录或 elevate 之后存起来。有效期 1 小时，过期由请求侧的 401 发现。 */
export function setAccountToken(token) {
  accountToken = token || null;
}

export function clearAccountToken() {
  accountToken = null;
}

export function isLoggedIn() {
  return Boolean(getToken());
}

/** 登录成功后存档。profile 只用于顶栏显示昵称/头像，权威数据仍以接口为准。 */
export function saveSession(token, profile) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile ?? {}));
}

export function getProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
  accountToken = null;
}

/**
 * 页面级登录守卫。未登录时跳登录页并带上 next，登录后能跳回来。
 * 返回 false 表示已经在跳转了，调用方应立刻停止渲染。
 */
export function requireLogin() {
  if (isLoggedIn()) return true;
  const next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
  location.replace(`${LOGIN_PAGE}?next=${next}`);
  return false;
}

export function logout() {
  clearSession();
  location.href = LOGIN_PAGE;
}

// ---------- 请求 ----------

/**
 * @param {string} path            以 /api 开头的路径
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {any}    [options.body]  会被 JSON 序列化
 * @param {boolean}[options.auth]  是否带 Bearer（默认带）
 * @param {boolean}[options.account]
 *        用 accountToken 而不是 profileToken。账号级端点（/api/profiles/*）需要，
 *        两者严格互斥——后端用授权策略强制，拿错了会 403 而不是静默降级。
 * @param {boolean}[options.redirectOnUnauthorized]
 *        401 时是否自动登出跳转。登录/注册这类接口必须传 false——
 *        那里的 401 是"密码错了"，不是"会话过期"，跳转会把错误提示一起冲掉。
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    auth = true,
    account = false,
    redirectOnUnauthorized = true,
    signal,
  } = options;

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const token = auth ? (account ? accountToken : getToken()) : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  // body 提前序列化成字符串，重试时才能原样重发（流式 body 是一次性的）。
  const init = {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };

  // 每个请求最多用掉一次重试机会（切线路或原地重试），线路来回抖时不至于打出重试风暴。
  let retried = false;
  let writeLockRetries = 0;

  for (;;) {
    const base = getApiBase();
    let response;

    try {
      response = await fetchWithTimeout(base + path, init, signal, REQUEST_TIMEOUT_MS);
    } catch (error) {
      // 调用方自己取消的，原样抛回去
      if (signal?.aborted) throw error;

      // fetch 只在网络层失败时抛异常，HTTP 错误码是不抛的。所以走到这里要么真断网、
      // 要么被 CORS 拦下（控制台有详细报错，页面上看不到）、要么连接进了黑洞被上面
      // 那个超时掐掉。三种症状一样，交给 canRetry 用探活分开。
      if (retried || !(await canRetry(base, method))) {
        throw new ApiError('网络请求失败，请检查网络连接后重试', 0);
      }
      retried = true;
      continue;
    }

    // 边缘或反代层的失败，请求没到过后端，和上面同一类处理
    if (isEdgeFailure(response.status)) {
      if (retried || !(await canRetry(base, method))) {
        throw new ApiError('线路暂时不可用，请稍后重试', response.status);
      }
      retried = true;
      continue;
    }

    if (response.status === 204) {
      scheduleProbe();
      return null;
    }

    const payload = await readBody(response);

    if (response.ok) {
      // 页面已经拿到数据了，这时候才轮到测速优选，结果下次导航生效。放在这里是因为
      // 只需要一个钩子，不用去改每个页面的引导代码；重复调用由 scheduleProbe 自己挡掉。
      scheduleProbe();
      return payload;
    }

    const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));

    // SQLite 写锁争用。后端的状态码规范里明写了这个 503 可以直接重试，而写锁超时
    // 意味着事务根本没提交，所以 POST 也安全。**不要**顺手把 429 也加进来——那个要
    // 让用户看见，describeError 会告诉他还得等多久。
    if (response.status === 503 && writeLockRetries < MAX_WRITE_LOCK_RETRIES) {
      writeLockRetries += 1;
      await delay(Math.min((retryAfterSeconds ?? 1) * 1000, MAX_WRITE_LOCK_BACKOFF_MS));
      continue;
    }

    // accountToken 只有 1 小时，过期是常态。这时候不能清 profileToken 把人踢出去，
    // 只要清掉账号凭据、让调用方重新 elevate（输一次密码）即可。
    if (response.status === 401 && account) {
      accountToken = null;
      throw new ApiError('账号凭据已过期，请重新验证密码', 401);
    }

    if (response.status === 401 && auth && redirectOnUnauthorized) {
      // token 过期、改过密码、被撤销管理员、账号已注销——本地凭据已经没用了。
      clearSession();
      const next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
      location.replace(`${LOGIN_PAGE}?next=${next}&expired=1`);
      throw new ApiError('登录已失效，请重新登录', 401);
    }

    // 其余状态码都是后端的真实答复。**绝不换线重试**——两个域名是同一个实例，
    // 换条线只会拿到一模一样的 400/403/404/429/500。
    throw new ApiError(
      payload?.message || defaultMessage(response.status),
      response.status,
      retryAfterSeconds,
    );
  }
}

export const get = (path, options) => request(path, { ...options, method: 'GET' });
export const post = (path, body, options) => request(path, { ...options, method: 'POST', body });
export const put = (path, body, options) => request(path, { ...options, method: 'PUT', body });
export const del = (path, options) => request(path, { ...options, method: 'DELETE' });

// ---------- 内部 ----------

/**
 * 链路层失败之后，判断这一发能不能重试。
 *
 * 判据在 endpoint.js 的 resolveFailure：探活两条线，把「线路坏了」和「这个请求自己
 * 的事」分开。
 *
 * - 线路坏了：两个域名是同一个实例，所以这种故障按定义就是请求**没到过后端**，
 *   切线重试对任何方法都安全，不会重复提交。
 * - 线路没坏：不能假设请求没被处理——它可能已经落库、只是回程丢了。这时只有幂等
 *   方法能原地重试，POST 必须把错误抛给用户，让他自己决定要不要再来一次。
 */
async function canRetry(base, method) {
  const verdict = await resolveFailure(base);
  if (verdict === 'switched') return true;
  if (verdict === 'line-ok') return IDEMPOTENT_METHODS.has(method);
  return false; // all-down：真断网，重试只是多等一个超时
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

function defaultMessage(status) {
  switch (status) {
    case 400: return '请求无效';
    case 401: return '邮箱或密码错误';
    case 403: return '没有权限访问';
    case 404: return '内容不存在';
    case 429: return '请求过于频繁，请稍后再试';
    case 503: return '服务器繁忙，请稍后重试';
    default: return `请求失败（HTTP ${status}）`;
  }
}

/** 把 ApiError 转成给用户看的一句话，429 会补上还要等多久。 */
export function describeError(error) {
  if (!(error instanceof ApiError)) return error?.message || '出错了，请重试';
  if (error.status === 429 && error.retryAfterSeconds) {
    return `${error.message}（约 ${error.retryAfterSeconds} 秒后可再试）`;
  }
  return error.message;
}

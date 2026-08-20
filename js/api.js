/**
 * Bnoawa API 客户端。
 *
 * 后端约定（见 Bnoawa/CLAUDE.md 的 HTTP 状态码规范）：
 * - 所有错误响应都是 { "message": "..." }，直接拿来显示给用户
 * - 401 = 凭据无效/过期；403 = 资源存在但当前不可见；404 才是真的没了
 * - 429 带 Retry-After 秒数
 */

export const API_BASE = resolveApiBase();

/**
 * 默认打生产后端。
 *
 * 本地开发时生产 CORS 不放行 localhost（Cors:DevelopmentOrigins 只在后端跑
 * Development 环境时才追加），所以本机调试要自己起一份后端，用
 * `?api=http://localhost:58271` 把地址切过去，会记住；`?api=` 清除。
 *
 * **只在页面自身来自 localhost 时才认这个参数。** 线上放开的话，
 * 一条 ?api=https://evil.example 链接就能把用户的账号密码送去别处。
 */
function resolveApiBase() {
  const DEFAULT = 'https://bnoawa.phi.zone';
  const KEY = 'anoawa.apiBase';

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!isLocal) return DEFAULT;

  const requested = new URLSearchParams(location.search).get('api');
  if (requested !== null) {
    if (requested) localStorage.setItem(KEY, requested.replace(/\/+$/, ''));
    else localStorage.removeItem(KEY);
  }

  const base = localStorage.getItem(KEY) || DEFAULT;
  if (base !== DEFAULT) console.info(`[anoawa] API 指向 ${base}（本机调试覆盖）`);
  return base;
}

const TOKEN_KEY = 'anoawa.token';
const PROFILE_KEY = 'anoawa.profile';
const LOGIN_PAGE = 'login.html';

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

  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // fetch 只在网络层失败时抛异常，HTTP 错误码是不抛的。所以走到这里
    // 要么真断网，要么被 CORS 拦下——后者在控制台有详细报错，页面上看不到。
    throw new ApiError('网络请求失败，请检查网络连接后重试', 0);
  }

  if (response.status === 204) return null;

  const payload = await readBody(response);

  if (response.ok) return payload;

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

  throw new ApiError(
    payload?.message || defaultMessage(response.status),
    response.status,
    parseRetryAfter(response.headers.get('Retry-After')),
  );
}

export const get = (path, options) => request(path, { ...options, method: 'GET' });
export const post = (path, body, options) => request(path, { ...options, method: 'POST', body });
export const put = (path, body, options) => request(path, { ...options, method: 'PUT', body });
export const del = (path, options) => request(path, { ...options, method: 'DELETE' });

// ---------- 内部 ----------

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

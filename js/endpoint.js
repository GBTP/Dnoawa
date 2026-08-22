/**
 * 后端线路选择与故障切换。
 *
 * Bnoawa 对外有两条线路，指向的是**同一个后端实例**：
 *
 *   主线路 bnoawa.phi.zone           Cloudflare → Caddy → Kestrel
 *   备用线路 bnoawa.10minstudio.work  TapTap 云引擎 CDN → TapTapProxy → Kestrel
 *
 * 「同一个实例」是这整个模块的判据来源：JWT 密钥一致、tus 用同一个 TusDiskStore、
 * 限流分区键都是还原后的真实客户端 IP，所以**换线路能救回来的故障，按定义都是
 * 「请求根本没到达后端」的链路故障**；后端自己给出的 4xx/5xx 换条线只会得到一模一样
 * 的答复。这既划出了该切与不该切的边界（见 api.js 的错误分类），也让「重试非幂等
 * 请求会不会重复提交」变得可控——链路断的时候请求没到过后端。
 *
 * 选路规则对齐 Unity 客户端的 BnoawaManager.SelectEndpointAsync：延迟差 100ms 以内
 * 留在主线路。两边的拓扑记录在 ../Bnoawa/CLAUDE.md 的「跨域与真实客户端 IP」一节。
 */

/** 顺序有意义：下标 0 是主线路，同速时优先它。 */
const ENDPOINTS = [
  'https://bnoawa.phi.zone',
  'https://bnoawa.10minstudio.work',
];

const CACHE_KEY = 'anoawa.endpoint';
const OVERRIDE_KEY = 'anoawa.apiBase';

/** 粘性缓存的有效期。够长到不必每次导航都测速，够短到网络环境变了能自己回正。 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** 与客户端 `req.timeout = 3` 对齐。 */
const PING_TIMEOUT_MS = 3000;

/** 延迟差在这个范围内就留在主线路，同样抄客户端。 */
const LATENCY_TIE_MS = 100;

/**
 * 本次页面生命周期里可用的线路。
 *
 * 本机调试指定了 ?api= 时**只剩那一个地址，整套切换逻辑随之关闭**——否则打
 * localhost 失败会切到生产，排障时会非常迷惑。
 */
const candidates = resolveCandidates();

let current = restoreCached();

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
function resolveCandidates() {
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!isLocal) return ENDPOINTS;

  const requested = new URLSearchParams(location.search).get('api');
  if (requested !== null) {
    if (requested) localStorage.setItem(OVERRIDE_KEY, requested.replace(/\/+$/, ''));
    else localStorage.removeItem(OVERRIDE_KEY);
  }

  const override = localStorage.getItem(OVERRIDE_KEY);
  if (!override) return ENDPOINTS;

  console.info(`[anoawa] API 指向 ${override}（本机调试覆盖，线路切换已关闭）`);
  return [override];
}

/**
 * 上次选中的线路，30 分钟内有效。
 *
 * 只读缓存、**绝不在加载期发探测**：网页每次导航都是一个全新的 JS 上下文，
 * 加载期测速等于给每个页面的首屏加一个往返。测速放在 scheduleProbe()，走空闲时间。
 */
function restoreCached() {
  if (candidates.length === 1) return candidates[0];

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && candidates.includes(cached.base) && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.base;
    }
  } catch {
    // 缓存坏了不是问题，回退到主线路即可
  }
  return candidates[0];
}

/** 立刻切过去，并记下来给下次导航用。只有故障切换该走这条。 */
function switchTo(base) {
  current = base;
  persist(base);
}

/**
 * 只记给下次导航，**不动当前页面正在用的线路**。
 *
 * 测速优选走这条而不是 switchTo：CORS 预检缓存是按 origin 存的，中途换 origin 会让
 * 本页后续每个带 Authorization 的请求都重新预检一轮，而当前 origin 的 TLS 连接已经热了。
 * 线路真的坏了，这个代价值得付；单纯「另一条快一点」不值。
 */
function persist(base) {
  if (candidates.length === 1) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ base, at: Date.now() }));
  } catch {
    // 无痕模式下 localStorage 可能抛，选路退化成每次导航从主线路开始，不影响可用性
  }
}

/** 当前线路，不带末尾斜杠。所有打后端的地方都要用它拼，别自己写死域名。 */
export function getApiBase() {
  return current;
}

/** 有没有可切换的第二条线。本机 ?api= 覆盖下为 false。 */
export function hasFailover() {
  return candidates.length > 1;
}

/** 除 base 之外的那条线，没有则 null。 */
function theOther(base) {
  return candidates.find((candidate) => candidate !== base) ?? null;
}

/**
 * 给 fetch 套上超时，同时不吃掉调用方自己的 AbortSignal。
 *
 * **这个超时是整套故障切换的前提。** fetch 默认没有超时，而线路被墙掉时最常见的形态
 * 不是立刻报错，是 SYN 被丢、连接进黑洞，浏览器要挂三十秒到一分半。没有超时，下面
 * 那套切换在最需要它的场景里根本不会触发——用户只看到页面一直转圈。
 *
 * 超时触发时抛的是 TimeoutError，调用方取消时抛的是 AbortError。调用方靠
 * `signal.aborted` 区分两者：前者要走故障判据，后者要原样抛回去。
 */
export function fetchWithTimeout(url, init, callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, {
    ...init,
    signal: callerSignal ? anySignal([callerSignal, timeout]) : timeout,
  });
}

/** AbortSignal.any 的兜底：Safari 17.4 之前没有它，而这个站的用户里 iOS 占大头。 */
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * 探活。
 *
 * /api/ping 是 CORS **简单请求**（GET、无自定义头、不带 Authorization），
 * 所以一次探测就是一个往返，不会先被预检吃掉一轮。别给它加头。
 */
export async function ping(base, timeoutMs = PING_TIMEOUT_MS) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/ping`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: Infinity };
  }
}

// ---------- 失败判据 ----------

/**
 * 边缘或反代层的失败——请求没到过后端。
 *
 * 后端自己从不返这些码（它返 500 和 503），而 TapTapProxy 连不上源站时返的恰恰是
 * `502 {"message":"proxy error: …"}`，Cloudflare 的 520–527 也是同一类。所以这几个
 * 状态一律按链路故障处理，**不看 body**——按 body 分辨反而会把 TapTapProxy 那条
 * 认成后端的答复。
 */
export function isEdgeFailure(status) {
  return status === 502 || status === 504 || (status >= 520 && status <= 527);
}

/** 同一轮里的并发失败共用一次探测，见 resolveFailure。 */
let inFlight = null;

/**
 * 请求失败了，判断这是「线路坏了」还是「这个请求自己的事」。
 *
 * 两者症状完全一样（fetch 抛 TypeError / 超时 / 502），直接重试是赌。ping 一下就能
 * 分开，代价是失败路径上多一个往返：
 *
 *   当前 DOWN、另一条 UP → 'switched'  链路故障，请求没到过后端，任何方法都可重试
 *   当前 UP              → 'line-ok'   线路没问题，可能这个请求其实到了后端，
 *                                      只有幂等方法可以原地重试
 *   两条都 DOWN          → 'all-down'  真断网，别重试
 *
 * @param {string} failedBase 失败时用的线路
 * @returns {Promise<'switched' | 'line-ok' | 'all-down'>}
 */
export function resolveFailure(failedBase) {
  // 页面并发发五个请求、线路又刚好断了的时候，五个失败会各自要一次判断。不去重的话
  // 那是十个探测请求；而且后到的那几个应该直接复用结论，不是再测一遍。
  if (inFlight) return inFlight;

  inFlight = probeBoth(failedBase).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function probeBoth(failedBase) {
  const other = theOther(failedBase);

  // 只有一条线（本机覆盖），没什么可判的
  if (!other) {
    const alone = await ping(failedBase);
    return alone.ok ? 'line-ok' : 'all-down';
  }

  // 已经有别人切走了：说明这一轮判过了，直接跟上
  if (current !== failedBase) return 'switched';

  const [failed, backup] = await Promise.all([ping(failedBase), ping(other)]);

  if (failed.ok) return 'line-ok';
  if (!backup.ok) return 'all-down';

  console.info(`[anoawa] ${failedBase} 不可用，切换到 ${other}`);
  switchTo(other);
  return 'switched';
}

// ---------- 测速优选 ----------

let probeScheduled = false;

/**
 * 空闲时测速，结果**只写进缓存、下次导航才生效**，当前页面用的线路一动不动（理由见 persist）。
 *
 * 调用点在 api.js 的第一次成功请求之后：那时页面已经拿到数据了，而且只需要一个钩子，
 * 不用去改八个 HTML 页面的引导代码。缓存还新鲜就直接跳过。
 *
 * 顺带把到胜出线路的 TLS 连接预热了。
 */
export function scheduleProbe() {
  if (probeScheduled || !hasFailover()) return;
  probeScheduled = true;

  if (isCacheFresh()) return;

  const run = () => { raceEndpoints().catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}

function isCacheFresh() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return Boolean(cached) && Date.now() - cached.at < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * 两条线并发测速，规则抄 BnoawaManager.SelectEndpointAsync：
 * 差值在 100ms 以内留在主线路，超过才换备线。
 *
 * 备用线路走的是 TapTap 云引擎的国内 CDN，主线路是 Cloudflare——对国内用户来说
 * 备线常常反而更快，这个测速不是摆设。
 */
async function raceEndpoints() {
  const [primary, fallback] = candidates;
  const [primaryResult, fallbackResult] = await Promise.all([ping(primary), ping(fallback)]);

  const describe = (result) => (result.ok ? `${result.ms}ms` : '不可用');
  console.info(`[anoawa] 主线路 ${describe(primaryResult)}，备用线路 ${describe(fallbackResult)}`);

  let best;
  if (primaryResult.ok && fallbackResult.ok) {
    best = primaryResult.ms - fallbackResult.ms <= LATENCY_TIE_MS ? primary : fallback;
  } else if (primaryResult.ok) {
    best = primary;
  } else if (fallbackResult.ok) {
    best = fallback;
  } else {
    // 都不通多半是本机断网，不是线路的问题。改缓存只会把错误的判断带到下次导航。
    return;
  }

  persist(best);
}

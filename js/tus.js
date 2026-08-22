/**
 * tus 可恢复上传客户端。
 *
 * 协议用法照搬 Unity SDK（Anoawa/Assets/Plugins/BnoawaSDK/BnoawaTusUploader.cs），
 * 两边必须一致，否则同一个后端会对网页和客户端表现出不同行为。
 *
 * 分片 1MB：与 SDK 一致，也稳稳避开 Cloudflare 免费版 100MB 的单请求体上限
 * （后端 tus 本身允许 200MB，但请求要穿过 Cloudflare）。
 *
 * 注意 tus 文件在服务端 30 分钟过期（Program.cs 的 AbsoluteExpiration），
 * 几个文件都传完后要尽快调 POST /api/levels 提交。
 *
 * **上传中途可以换线路。** 两个域名指向同一个后端实例、共用同一个 TusDiskStore，
 * 所以 file ID 在两条线上都认；而 tus 本身是按 offset 续传的，服务端回报的 offset
 * 才是权威，重发同一段不会写重。上传是全站耗时最长、最容易撞上线路故障的操作，
 * 而 tus 文件 30 分钟就过期，重来一遍代价很大——这个能力是值得的。
 */

import { getToken, ApiError } from './api.js';
import { getApiBase, resolveFailure, fetchWithTimeout, isEdgeFailure } from './endpoint.js';

const CHUNK_SIZE = 1024 * 1024;
const TUS_VERSION = '1.0.0';

/**
 * 分片的超时要单独给，不能跟着 api.js 的 12 秒——1MB 在慢上行链路上传得比那久。
 * 60 秒对应大约 140kbps 的上行，比这还慢的网络本来也传不完一张谱面。
 */
const PATCH_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 12_000;
const HEAD_TIMEOUT_MS = 10_000;

/** 同一个分片连续失败这么多次就放弃，别在断续的网络里无限重试到 tus 文件过期。 */
const MAX_CHUNK_ATTEMPTS = 3;

/** 后端 OnBeforeCreateAsync 只认这几种，别的会被拒。 */
export const FILE_TYPES = ['cover', 'music', 'chart', 'avatar', 'preview', 'video'];

/**
 * 上传一个文件，返回 tus file ID。
 *
 * @param {Blob} blob
 * @param {object} options
 * @param {string} options.fileType  cover / music / chart / preview / video
 * @param {string} options.name      存进云存储时用的文件名
 * @param {(ratio: number) => void} [options.onProgress] 0~1
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export async function uploadFile(blob, { fileType, name, onProgress, signal }) {
  if (!FILE_TYPES.includes(fileType)) {
    throw new Error(`不支持的 fileType: ${fileType}`);
  }

  const token = getToken();
  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};

  // 1. 创建上传
  const uploadPath = await createUpload(blob, { fileType, name, authHeader, signal });

  // 2. 分片 PATCH
  let offset = 0;
  let attempts = 0;
  onProgress?.(0);

  while (offset < blob.size) {
    // 每一轮都重新取线路：上一轮的恢复可能已经把线路切走了。file ID 两条线通用，
    // 换的只是 origin。
    const uploadUrl = getApiBase() + uploadPath;
    const end = Math.min(offset + CHUNK_SIZE, blob.size);

    let response;
    try {
      response = await fetchWithTimeout(uploadUrl, {
        method: 'PATCH',
        headers: {
          ...authHeader,
          'Tus-Resumable': TUS_VERSION,
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: blob.slice(offset, end),
      }, signal, PATCH_TIMEOUT_MS);
    } catch (error) {
      if (signal?.aborted) throw error;
      attempts += 1;
      offset = await recover(uploadPath, authHeader, signal, attempts);
      onProgress?.(offset / blob.size);
      continue;
    }

    // 边缘或反代挂了，请求没到过后端。和上面同一类，区别只是它给了个状态码。
    if (isEdgeFailure(response.status)) {
      attempts += 1;
      offset = await recover(uploadPath, authHeader, signal, attempts);
      onProgress?.(offset / blob.size);
      continue;
    }

    if (!response.ok) {
      // 这里的 4xx 是后端的真实答复，**不重试也不换线**——换条线是同一个实例，
      // 会得到一模一样的拒绝。音频/视频校验是在最后一片写完时触发的
      // （OnFileCompleteAsync），所以格式不合规会表现成最后一个分片 4xx，
      // 而不是创建时就失败。
      const message = await readMessage(response);
      throw new ApiError(message || `分片上传失败（HTTP ${response.status}）`, response.status);
    }

    // 以服务端回报的 offset 为准，不要自己累加——断点续传时两者会不一致
    const serverOffset = Number.parseInt(response.headers.get('Upload-Offset') ?? '', 10);
    offset = Number.isFinite(serverOffset) ? serverOffset : end;
    attempts = 0;

    onProgress?.(offset / blob.size);
  }

  return uploadPath.split('/').filter(Boolean).pop();
}

/**
 * 创建上传，返回 file 的路径（如 `/api/files/{id}`）。
 *
 * 返回路径而不是完整 URL：后面每次续传都要用当时选中的线路重新拼 origin。
 *
 * 链路故障时可以重发——**这一点是 tus 创建独有的**，POST /api/levels 那种就不行。
 * 重发最坏只是在服务端留下一个没人认领的空文件，TusFileCleanupService 会清掉它，
 * 而且 30 分钟本来也会过期。所以这里比 api.js 的判据更宽：只要不是两条线都断，
 * 就再试一次。
 */
async function createUpload(blob, { fileType, name, authHeader, signal }) {
  for (let attempt = 1; ; attempt += 1) {
    const base = getApiBase();
    let created;

    try {
      created = await fetchWithTimeout(`${base}/api/files`, {
        method: 'POST',
        headers: {
          ...authHeader,
          'Tus-Resumable': TUS_VERSION,
          'Upload-Length': String(blob.size),
          'Upload-Metadata': encodeMetadata({ name, fileType }),
        },
      }, signal, CREATE_TIMEOUT_MS);
    } catch (error) {
      if (signal?.aborted) throw error;
      await requireLineUsable(base, attempt);
      continue;
    }

    if (isEdgeFailure(created.status)) {
      await requireLineUsable(base, attempt);
      continue;
    }

    if (!created.ok) {
      throw new ApiError(
        created.status === 401 ? '登录已失效，请重新登录' : `创建上传失败（HTTP ${created.status}）`,
        created.status);
    }

    // Location 是跨域下必须由后端显式 expose 的响应头，读不到就拿不到 file ID
    const location = created.headers.get('Location');
    if (!location) {
      throw new Error('服务端没有返回 Location，无法继续上传');
    }

    return new URL(location, base).pathname;
  }
}

/**
 * 分片失败后的恢复：先判线路，再向服务端问回权威的 offset。
 *
 * 判据在 endpoint.js 的 resolveFailure。这里对 'line-ok'（线路没坏、是这一发自己的事）
 * 也继续重试，而 api.js 那边对非幂等方法是直接抛的——差别在于 tus 有服务端 offset
 * 这个权威事实可查：不管上一片到底写进去没有，HEAD 一次就知道，重发不会写重。
 */
async function recover(uploadPath, authHeader, signal, attempts) {
  const verdict = await resolveFailure(getApiBase());

  if (verdict === 'all-down') {
    throw new ApiError('网络请求失败，请检查网络连接后重试', 0);
  }
  if (attempts >= MAX_CHUNK_ATTEMPTS) {
    throw new ApiError('上传中断，请重试', 0);
  }

  return headOffset(getApiBase() + uploadPath, authHeader, signal);
}

/** 创建阶段的判线：链路坏了就已经切好了，两条都断才放弃。 */
async function requireLineUsable(base, attempt) {
  const verdict = await resolveFailure(base);
  if (verdict === 'all-down') {
    throw new ApiError('网络请求失败，请检查网络连接后重试', 0);
  }
  if (attempt >= 2) {
    throw new ApiError('创建上传失败，请重试', 0);
  }
}

/**
 * 向服务端问回权威的 Upload-Offset，续传从这里接着走。
 *
 * 后端不用改：HEAD 在 CORS 策略的 WithMethods 里，Upload-Offset 在 WithExposedHeaders
 * 里，tus 的 OnAuthorizeAsync 对 HEAD 一样放行。
 */
async function headOffset(url, authHeader, signal) {
  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: { ...authHeader, 'Tus-Resumable': TUS_VERSION },
      cache: 'no-store',
    }, signal, HEAD_TIMEOUT_MS);
  } catch (error) {
    if (signal?.aborted) throw error;
    // 问 offset 这一步自己也挂了。不再往下探——外层的 attempts 会带着我们重来一轮，
    // 抛裸 TypeError 只会让上传界面显示 "Failed to fetch"。
    throw new ApiError('无法确认上传进度，请重试', 0);
  }

  // tus 文件 30 分钟过期，断得久了会走到这
  if (response.status === 404 || response.status === 410) {
    throw new ApiError('上传已过期，请重新上传', response.status);
  }
  if (!response.ok) {
    throw new ApiError(`无法确认上传进度（HTTP ${response.status}）`, response.status);
  }

  const serverOffset = Number.parseInt(response.headers.get('Upload-Offset') ?? '', 10);
  if (!Number.isFinite(serverOffset)) {
    throw new ApiError('服务端没有返回 Upload-Offset，无法续传', 0);
  }
  return serverOffset;
}

/** tus 的 Upload-Metadata 是 `key base64(value)` 用逗号分隔。 */
function encodeMetadata(pairs) {
  return Object.entries(pairs)
    .map(([key, value]) => `${key} ${base64Utf8(value)}`)
    .join(',');
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readMessage(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      return JSON.parse(text).message || text;
    } catch {
      return text;
    }
  } catch {
    return '';
  }
}

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
 */

import { API_BASE, getToken, ApiError } from './api.js';

const CHUNK_SIZE = 1024 * 1024;
const TUS_VERSION = '1.0.0';

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
  const created = await fetch(`${API_BASE}/api/files`, {
    method: 'POST',
    headers: {
      ...authHeader,
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(blob.size),
      'Upload-Metadata': encodeMetadata({ name, fileType }),
    },
    signal,
  });

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

  const uploadUrl = new URL(location, API_BASE).toString();
  const fileId = uploadUrl.split('/').filter(Boolean).pop();

  // 2. 分片 PATCH
  let offset = 0;
  onProgress?.(0);

  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK_SIZE, blob.size);

    const response = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        ...authHeader,
        'Tus-Resumable': TUS_VERSION,
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: blob.slice(offset, end),
      signal,
    });

    if (!response.ok) {
      // 音频/视频校验是在最后一片写完时触发的（OnFileCompleteAsync），
      // 所以格式不合规会表现成最后一个分片 4xx，而不是创建时就失败
      const message = await readMessage(response);
      throw new ApiError(message || `分片上传失败（HTTP ${response.status}）`, response.status);
    }

    // 以服务端回报的 offset 为准，不要自己累加——断点续传时两者会不一致
    const serverOffset = Number.parseInt(response.headers.get('Upload-Offset') ?? '', 10);
    offset = Number.isFinite(serverOffset) ? serverOffset : end;

    onProgress?.(offset / blob.size);
  }

  return fileId;
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

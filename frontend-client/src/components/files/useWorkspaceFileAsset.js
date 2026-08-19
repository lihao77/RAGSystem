/**
 * 工作区文件资源层：file_ref 渲染统一经此获取 blob。
 *
 * - 模块级 LRU 缓存 Blob（聊天列表虚拟滚动反复挂载时不重复下载）；
 * - in-flight 去重（同一文件并发请求只发一次）；
 * - 按扩展名修正 content-type（Local 部署对 pdf/音视频回退 octet-stream）；
 * - 组件级 objectURL 生命周期管理（切换/卸载自动 revoke）。
 */

import { onUnmounted, ref, shallowRef, toValue, watch } from 'vue';
import { getWorkspaceFileContent } from '../../api/workspaceFile.js';
import { correctMimeType } from './fileCategorize.js';

const CACHE_MAX_ENTRIES = 16;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** @type {Map<string, { blob: Blob, size: number, mimeType: string }>} */
const assetCache = new Map();
/** @type {Map<string, Promise<{ blob: Blob, size: number, mimeType: string }>>} */
const inflight = new Map();

function buildKey(sessionId, filePath) {
  return `${sessionId}::${filePath}`;
}

function cacheBytes() {
  let total = 0;
  for (const entry of assetCache.values()) total += entry.size;
  return total;
}

function evictIfNeeded() {
  while (assetCache.size > CACHE_MAX_ENTRIES || cacheBytes() > CACHE_MAX_BYTES) {
    const oldest = assetCache.keys().next().value;
    if (oldest === undefined) break;
    assetCache.delete(oldest);
  }
}

/**
 * 获取（或复用缓存的）工作区文件资源。
 * @returns {Promise<{ blob: Blob, size: number, mimeType: string }>}
 */
export function fetchWorkspaceFileAsset(sessionId, filePath, options = {}) {
  const key = buildKey(sessionId, filePath);
  const cached = assetCache.get(key);
  if (cached) {
    // 刷新 LRU 最近使用位
    assetCache.delete(key);
    assetCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    const response = await getWorkspaceFileContent(sessionId, filePath, { signal: options.signal });
    const rawBlob = response.data instanceof Blob ? response.data : new Blob([response.data]);
    const headerType = response.headers?.['content-type']?.split(';')[0] || '';
    const mimeType = correctMimeType(rawBlob.type || headerType, filePath);
    const blob = mimeType && rawBlob.type !== mimeType ? new Blob([rawBlob], { type: mimeType }) : rawBlob;
    const entry = { blob, size: Number(response.headers?.['content-length']) || rawBlob.size, mimeType };
    assetCache.set(key, entry);
    evictIfNeeded();
    return entry;
  })();

  inflight.set(key, request);
  request.finally(() => inflight.delete(key)).catch(() => {});
  return request;
}

/** 测试用：清空模块级缓存。 */
export function clearWorkspaceFileAssetCache() {
  assetCache.clear();
  inflight.clear();
}

/**
 * 组件级 composable：绑定 sessionId/filePath（支持 ref），暴露加载状态与资产。
 * objectUrl 惰性创建（ensureObjectUrl），来源变化/卸载时统一 revoke。
 */
export function useWorkspaceFileAsset(sessionIdSource, filePathSource) {
  const loading = ref(true);
  const error = ref('');
  const asset = shallowRef(null);
  let requestVersion = 0;
  let objectUrl = '';
  // 记录 URL 对应的 asset 引用：filePath 切换期间 asset 尚未更新时，
  // 仅凭 key 缓存会把旧文件的 URL 发给新渲染（iframe/video 会一直显示旧内容），
  // 因此必须比较 asset 身份而非 key。
  let objectUrlAsset = null;

  async function load() {
    const version = ++requestVersion;
    const sessionId = toValue(sessionIdSource);
    const filePath = toValue(filePathSource);
    loading.value = true;
    error.value = '';
    try {
      const entry = await fetchWorkspaceFileAsset(sessionId, filePath);
      if (version !== requestVersion) return;
      asset.value = entry;
    } catch (cause) {
      if (version !== requestVersion) return;
      asset.value = null;
      error.value = cause?.status === 404 ? '文件不存在或已过期' : (cause?.message || '加载文件失败');
    } finally {
      if (version === requestVersion) loading.value = false;
    }
  }

  function releaseObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    objectUrlAsset = null;
  }

  function ensureObjectUrl() {
    if (!asset.value) return '';
    if (objectUrl && objectUrlAsset === asset.value) return objectUrl;
    releaseObjectUrl();
    objectUrl = URL.createObjectURL(asset.value.blob);
    objectUrlAsset = asset.value;
    return objectUrl;
  }

  watch(
    () => [toValue(sessionIdSource), toValue(filePathSource)],
    () => {
      releaseObjectUrl();
      load();
    },
    { immediate: true },
  );

  onUnmounted(() => {
    requestVersion += 1;
    releaseObjectUrl();
  });

  return { loading, error, asset, ensureObjectUrl, reload: load };
}

/** 解码文本类 blob（限流截断），供 md/code/json/csv 渲染。 */
export async function blobToText(blob, limit) {
  const truncated = blob.size > limit;
  const slice = truncated ? blob.slice(0, limit) : blob;
  const text = new TextDecoder('utf-8').decode(await slice.arrayBuffer());
  return { text, truncated };
}

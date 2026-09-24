/**
 * 工作区文件资源层：file_ref 渲染统一经此获取 blob。
 *
 * - 模块级 LRU 缓存 Blob（聊天列表虚拟滚动反复挂载时不重复下载）；
 * - 缓存命中时带 If-None-Match 重验证：未变更（304）原对象复用——组件侧 asset 身份
 *   不变，不重建 objectURL、不重解码文本、无闪烁；会话中途改写过的文件（200）换新
 *   内容，修复"模型改完文件再引用，前端仍显示旧内容"的脏读；
 * - 后端未提供 etag 时无法廉价重验证，退化为每次全量拉取（保证不脏读）；
 * - in-flight 去重（同一文件并发请求只发一次）；
 * - 按扩展名修正 content-type（Local 部署对 pdf/音视频回退 octet-stream）；
 * - 组件级 objectURL 生命周期管理（切换/卸载自动 revoke）。
 */

import { onUnmounted, ref, shallowRef, toValue, watch } from 'vue';
import { getWorkspaceEntryContent, getWorkspaceFileContent } from '../../api/workspaceFile.js';
import { correctMimeType } from './fileCategorize.js';

const CACHE_MAX_ENTRIES = 16;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** @type {Map<string, { blob: Blob, size: number, mimeType: string, etag: string }>} */
const assetCache = new Map();
/** @type {Map<string, Promise<{ blob: Blob, size: number, mimeType: string, etag: string }>>} */
const inflight = new Map();

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

function commitEntry(key, entry) {
  assetCache.set(key, entry);
  evictIfNeeded();
  return entry;
}

function responseEtag(response) {
  const etag = response?.headers?.etag;
  return typeof etag === 'string' ? etag.trim() : '';
}

function buildEntry(response, filePath) {
  const rawBlob = response.data instanceof Blob ? response.data : new Blob([response.data]);
  const headerType = response.headers?.['content-type']?.split(';')[0] || '';
  const mimeType = correctMimeType(rawBlob.type || headerType, filePath);
  const blob = mimeType && rawBlob.type !== mimeType ? new Blob([rawBlob], { type: mimeType }) : rawBlob;
  return { blob, size: Number(response.headers?.['content-length']) || rawBlob.size, mimeType, etag: responseEtag(response) };
}

/**
 * 获取（或复用缓存的）文件资源核心。缓存命中时会向服务端确认版本：
 * 304 复用原条目、200 替换为新内容、404 清缓存抛错；其余重验证失败（网络/5xx）
 * 退回缓存内容，不让瞬断把已能展示的文件打成加载失败。
 * @param {string} key 缓存键（会话级/项目级各自命名空间）
 * @param {string} filePath
 * @param {(filePath: string, options: object) => Promise<object>} loadContent 内容请求（返回 axios 风格 response）
 * @returns {Promise<{ blob: Blob, size: number, mimeType: string, etag: string }>}
 */
function fetchFileAsset(key, filePath, loadContent, options = {}) {
  const cached = assetCache.get(key);
  if (cached) {
    // 刷新 LRU 最近使用位
    assetCache.delete(key);
    assetCache.set(key, cached);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    if (cached?.etag) {
      try {
        const response = await loadContent(filePath, { signal: options.signal, ifNoneMatch: cached.etag });
        // 304 时经 commitEntry 回插（await 期间可能被 LRU 淘汰），并原对象复用——
        // 组件侧 asset 身份不变，不重建 objectURL、不重解码文本
        if (response.status === 304) return commitEntry(key, cached);
        return commitEntry(key, buildEntry(response, filePath));
      } catch (cause) {
        // abort 判定看 signal 状态而非错误 code：http.js 错误拦截器会重包装错误，CanceledError 标记不存活
        if (options.signal?.aborted) throw cause;
        // 404 是确定性答案（文件已删除）：清缓存并如实报错
        if (cause?.status === 404) {
          assetCache.delete(key);
          throw cause;
        }
        // 其余瞬断（网络/5xx）退回缓存内容，不让一次抖动把已能展示的文件打成加载失败
        return commitEntry(key, cached);
      }
    }
    try {
      const response = await loadContent(filePath, { signal: options.signal });
      return commitEntry(key, buildEntry(response, filePath));
    } catch (cause) {
      if (cause?.status === 404) assetCache.delete(key);
      throw cause;
    }
  })();

  inflight.set(key, request);
  request.finally(() => inflight.delete(key)).catch(() => {});
  return request;
}

/** 会话工作区文件（sessionId 命名空间，保持既有缓存键格式）。 */
export function fetchWorkspaceFileAsset(sessionId, filePath, options = {}) {
  return fetchFileAsset(`${sessionId}::${filePath}`, filePath, (fp, opts) => getWorkspaceFileContent(sessionId, fp, opts), options);
}

/** 项目（workspace）文件：文件浏览器右侧查看页签使用，与项目目录列表同一作用域。 */
export function fetchWorkspaceEntryAsset(workspaceId, filePath, options = {}) {
  return fetchFileAsset(`workspace:${workspaceId}::${filePath}`, filePath, (fp, opts) => getWorkspaceEntryContent(workspaceId, fp, opts), options);
}

/** 测试用：清空模块级缓存。 */
export function clearWorkspaceFileAssetCache() {
  assetCache.clear();
  inflight.clear();
}

/**
 * 组件级 composable 工厂：绑定 id/filePath 两个来源（支持 ref），暴露加载状态与资产。
 * objectUrl 惰性创建（ensureObjectUrl），来源变化/卸载时统一 revoke。
 */
function bindFileAsset(fetchEntry) {
  return (idSource, filePathSource) => {
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
      loading.value = true;
      error.value = '';
      try {
        const entry = await fetchEntry(toValue(idSource), toValue(filePathSource));
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
      () => [toValue(idSource), toValue(filePathSource)],
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
  };
}

export const useWorkspaceFileAsset = bindFileAsset((sessionId, filePath) => fetchWorkspaceFileAsset(sessionId, filePath));
export const useWorkspaceEntryAsset = bindFileAsset((workspaceId, filePath) => fetchWorkspaceEntryAsset(workspaceId, filePath));

/** 解码文本类 blob（限流截断），供 md/code/json/csv 渲染。 */
export async function blobToText(blob, limit) {
  const truncated = blob.size > limit;
  const slice = truncated ? blob.slice(0, limit) : blob;
  const text = new TextDecoder('utf-8').decode(await slice.arrayBuffer());
  return { text, truncated };
}

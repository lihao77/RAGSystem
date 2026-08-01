import { http } from '../api/http.js';

/**
 * 原生 <img> 无法附带 SaaS Bearer token。对同源 /api 资源先走统一 HTTP client
 * 拉取 Blob，再交给浏览器对象 URL 渲染；blob/data/普通静态资源保持直连。
 */
export function isAuthenticatedApiUrl(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return false;
  if (/^\/api(?:\/|$)/.test(source)) return true;
  if (typeof window === 'undefined') return false;

  try {
    const url = new URL(source, window.location.href);
    return url.origin === window.location.origin && /^\/api(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function resolveAuthenticatedMediaUrl(value, { signal, fetchAsset } = {}) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source || !isAuthenticatedApiUrl(source)) {
    return { src: source, release: () => {} };
  }

  const response = fetchAsset
    ? await fetchAsset(source, { signal })
    : await http.getRaw(source, { responseType: 'blob', signal });
  const blob = typeof response?.blob === 'function' ? await response.blob() : response.data;
  const objectUrl = URL.createObjectURL(blob);
  let released = false;

  return {
    src: objectUrl,
    release: () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(objectUrl);
    },
  };
}

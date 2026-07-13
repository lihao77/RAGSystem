/**
 * 统一 HTTP client。
 *
 * 全项目唯一请求出口：替换各 api 文件原本各自重造的 parseResponse/request/requestJson。
 * 基于 axios 实现，导出 httpClient 实例供测试用 axios-mock-adapter 注入。
 *
 * 职责边界：
 *   - 请求侧：空 body 不带 Content-Type（Fastify FST_ERR_CTP_EMPTY_JSON_BODY 兼容）；
 *     FormData 由 axios 自动设置 multipart 边界；普通对象由 axios 自动 JSON 序列化。
 *   - 响应侧：成功返回后端 JSON 整体（axios resp.data，不抽 .data，由各 api 函数按需取
 *     .data/.items/.providers…）；失败抛 Error，message 统一为
 *     detail(支持 Fastify 数组校验错) || message || `请求失败: ${status}`。
 *   - 从认证 store 注入 session token；不设全局超时（长任务：
 *     向量化/导出/上传保持现状无超时，需要时按请求级传入 signal）。
 */

import axios from 'axios';

function describeError(body, status) {
  if (body && typeof body === 'object') {
    const { detail, message } = body;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      return detail
        .map((item) => item?.msg || JSON.stringify(item))
        .join('; ');
    }
    if (typeof message === 'string' && message) return message;
  }
  return `请求失败: ${status}`;
}

export const httpClient = axios.create({
  // 同源相对路径，不设 baseURL；不设 timeout 以兼容长任务。
});

httpClient.interceptors.request.use(async (config) => {
  const { useAuthStore } = await import('../stores/auth.js');
  const authStore = useAuthStore();
  if (authStore.token) {
    config.headers.set('Authorization', `Bearer ${authStore.token}`);
  }

  // 空 body 请求清除 axios 默认注入的 Content-Type（axios 默认给 POST/PUT 加 application/json），
  // 避免 DELETE / 无 body POST 触发 Fastify FST_ERR_CTP_EMPTY_JSON_BODY。
  // FormData 与普通对象由 axios 自动处理 Content-Type（multipart 边界 / application/json）。
  if (config.data === undefined || config.data === null) {
    config.headers?.delete?.('Content-Type');
  }
  return config;
});

httpClient.interceptors.response.use(
  (resp) => (resp.config?._rawResponse ? resp : resp.data),
  async (err) => {
    const status = err?.response?.status ?? 0;
    const body = err?.response?.data;
    const error = new Error(describeError(body, status));
    error.status = status;
    if (status === 401) {
      const [{ useAuthStore }, { default: router }] = await Promise.all([
        import('../stores/auth.js'),
        import('../router/index.js'),
      ]);
      useAuthStore().clear();
      if (router.currentRoute.value.path !== '/login') {
        await router.replace({
          path: '/login',
          query: { redirect: router.currentRoute.value.fullPath },
        });
      }
    }
    return Promise.reject(error);
  },
);

/**
 * 低层入口：与 fetch 形态对齐，便于逐函数替换。
 * @param {string} url
 * @param {{method?: string, body?: any, headers?: object, params?: object, signal?: AbortSignal}} [options]
 * @returns {Promise<any>} 后端 JSON 整体
 */
export async function request(url, options = {}) {
  const config = {
    url,
    method: (options.method || 'GET').toUpperCase(),
    headers: options.headers,
    params: options.params,
    signal: options.signal,
  };
  if (options.body !== undefined) {
    // 对象 / 字符串 / FormData 都直接交给 axios（对象自动 JSON 序列化，FormData 自动 multipart）。
    config.data = options.body;
  }
  return httpClient.request(config);
}

/**
 * 取原始响应（含 data/headers/status），用于 blob 下载等需要 headers 或非 JSON body 的场景。
 * 失败仍抛 Error（与 request 一致，且 error.status 可用）。options.responseType 指定解析类型。
 */
export async function getRaw(url, options = {}) {
  return httpClient.request({
    url,
    method: (options.method || 'GET').toUpperCase(),
    responseType: options.responseType,
    headers: options.headers,
    params: options.params,
    signal: options.signal,
    _rawResponse: true,
  });
}

export const http = {
  request,
  getRaw,
  get: (url, options = {}) => request(url, { ...options, method: 'GET' }),
  post: (url, body, options = {}) => request(url, { ...options, method: 'POST', body }),
  put: (url, body, options = {}) => request(url, { ...options, method: 'PUT', body }),
  patch: (url, body, options = {}) => request(url, { ...options, method: 'PATCH', body }),
  del: (url, options = {}) => request(url, { ...options, method: 'DELETE' }),
};

export default http;

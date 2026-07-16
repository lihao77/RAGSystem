/**
 * node test runner 全局 preload（CJS，--require）：mock 浏览器全局。
 *
 * 用 CJS --require 而非 ESM --import：--import 会走 ESM loader 钩子，干扰
 * axios-mock-adapter 对 httpClient 的拦截（所有 mock 请求 status 0）。
 * CJS --require 同步执行，只设 globalThis，不触碰 loader，不影响 mock。
 *
 * node 环境（node --test）无 localStorage，stores/auth.js 等 pinia store 初始化
 * 时访问 localStorage（token 持久化）——不 mock 会抛 "localStorage is not defined"，
 * 连带 http.js request 拦截器（useAuthStore）抛、mock 接不到请求。
 */
const makeStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    key: (index) => Array.from(store.keys())[index] ?? null,
    clear: () => { store.clear(); },
    get length() { return store.size; },
  };
};

if (globalThis.localStorage === undefined) {
  globalThis.localStorage = makeStorage();
}
if (globalThis.sessionStorage === undefined) {
  globalThis.sessionStorage = makeStorage();
}

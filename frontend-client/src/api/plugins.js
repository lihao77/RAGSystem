/**
 * 插件清单 API（backend-core /api/plugins）。
 *
 * 两类端点：
 *   - GET /api/plugins/ui-manifests（public）：exposePublic 插件的 view 清单，
 *     路由守卫在认证前加载并动态挂路由（如宠物独立窗直开 /pet）；
 *   - GET /api/plugins（tenant）：完整插件清单（id/version/ui/configGroups），
 *     插件设置页按 configGroups 从 system-config schema 取分组渲染。
 */
import { http } from './http.js';

/** @returns {Promise<Array<{ id: string, bundleUrl: string, views: Array<object> }>>} */
export async function getPluginUiManifests() {
  const result = await http.get('/api/plugins/ui-manifests');
  return result?.data?.plugins ?? [];
}

/** @returns {Promise<Array<{ id: string, version: string, ui: object | null, configGroups: string[] }>>} */
export async function getInstalledPlugins() {
  const result = await http.get('/api/plugins');
  return result?.data?.plugins ?? [];
}

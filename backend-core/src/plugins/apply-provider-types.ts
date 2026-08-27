import type { ModelAdapterService } from "../services/integrations/model-adapter-service.js";
import type { BackendRuntimeContributions } from "./backend-plugin.js";

/**
 * 把插件注册的 Provider 类型注入 ModelAdapterService（部署容器创建 service 后调用）。
 * 注册早于运行时 provider 水合与首个请求；冲突类型在此抛错并终止启动（与插件装载语义一致）。
 */
export function registerPluginProviderTypes(
  service: ModelAdapterService,
  contributions: Pick<BackendRuntimeContributions, "listProviderTypes"> | undefined | null,
): void {
  if (!contributions) return;
  for (const contribution of contributions.listProviderTypes()) {
    service.registerProviderTypes(contribution.pluginId, contribution.types);
  }
}

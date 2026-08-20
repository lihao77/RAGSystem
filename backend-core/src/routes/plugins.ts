import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import type { BackendUiContribution } from "../plugins/backend-plugin.js";
import { requireTenantMember } from "./tenant-role.js";

/** core-app 注入的插件清单访问器（来自 BackendPluginManager）。 */
export interface PluginListingOptions {
  listPlugins: () => readonly { id: string; version: string }[];
  listUi: () => readonly BackendUiContribution[];
}

/** 挂 public scope（prefix /api）：exposePublic 插件的 view 最小清单，认证前路由挂载用（如宠物独立窗直开 /pet）。 */
export const registerPublicPluginUiManifestRoutes: FastifyPluginAsync<PluginListingOptions> = async (app, options) => {
  app.get("/plugins/ui-manifests", async () =>
    ok(
      {
        plugins: options
          .listUi()
          .filter((contribution) => contribution.manifest.exposePublic === true)
          .map((contribution) => ({
            id: contribution.pluginId,
            bundleUrl: contribution.manifest.bundleUrl,
            views: contribution.manifest.views,
          })),
      },
      "插件 UI 清单",
    ),
  );
};

/** 挂 tenant scope（prefix /api/plugins）：完整插件清单，配置组按 sourceExtension 归属插件。 */
export const registerTenantPluginRoutes: FastifyPluginAsync<PluginListingOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
  });

  app.get("/", async (request) => {
    const groups = request.container.systemConfig.getSchema().groups;
    const uiByPlugin = new Map<string, BackendUiContribution["manifest"]>();
    for (const contribution of options.listUi()) uiByPlugin.set(contribution.pluginId, contribution.manifest);
    return ok(
      {
        plugins: options.listPlugins().map((plugin) => {
          const ui = uiByPlugin.get(plugin.id);
          return {
            id: plugin.id,
            version: plugin.version,
            ui: ui ? { bundleUrl: ui.bundleUrl, views: ui.views } : null,
            configGroups: groups
              .filter((group) => group.sourceExtension === plugin.id)
              .map((group) => group.key),
          };
        }),
      },
      "已安装插件清单",
    );
  });
};

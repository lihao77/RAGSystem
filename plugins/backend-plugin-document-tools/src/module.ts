import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createDocumentToolsPlugin, DOCUMENT_TOOLS_PLUGIN_ID } from "./plugin.js";
import { createLocalDocumentToolsRuntimeFactory } from "./storage/local/runtime.js";
import { createSaaSDocumentToolsRuntimeFactory } from "./storage/saas/runtime.js";

const localRuntimeFactory = createLocalDocumentToolsRuntimeFactory();
const saasRuntimeFactory = createSaaSDocumentToolsRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: DOCUMENT_TOOLS_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createDocumentToolsPlugin({
      runtimeFactory: (context) => context.deploymentKind === "local"
        ? localRuntimeFactory(context)
        : saasRuntimeFactory(context),
    });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Document tools plugin does not accept configuration");
}

import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createDocumentToolsPlugin, DOCUMENT_TOOLS_PLUGIN_ID } from "./plugin.js";
import { createLocalDocumentToolsRuntimeFactory } from "./storage/local/runtime.js";
import { createSandboxedDocumentToolsRuntimeFactory } from "./storage/saas/runtime.js";
import { findDocumentToolsSandbox } from "./resources.js";

const localRuntimeFactory = createLocalDocumentToolsRuntimeFactory();
const sandboxedRuntimeFactory = createSandboxedDocumentToolsRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: DOCUMENT_TOOLS_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createDocumentToolsPlugin({
      runtimeFactory: (context) => context.deploymentKind === "local"
        ? (findDocumentToolsSandbox(context.resources) ? sandboxedRuntimeFactory(context) : localRuntimeFactory(context))
        : sandboxedRuntimeFactory(context),
    });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Document tools plugin does not accept configuration");
}

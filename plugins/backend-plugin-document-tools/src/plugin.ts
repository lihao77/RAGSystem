import type { BackendPlugin, BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { DOCUMENT_TOOLS_RUNTIME_CAPABILITY } from "./capability.js";
import type { DocumentToolsPluginDependencies } from "./dependencies.js";
import { createDocumentTools } from "./tools/DocumentTools/DocumentTools.js";

export const DOCUMENT_TOOLS_PLUGIN_ID = "@ragsystem/backend-plugin-document-tools";

const TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  { name: "read_file", description: "Read a file from the managed workspace", category: "filesystem", risk_level: "low" },
  { name: "write_file", description: "Write a file in the managed workspace", category: "filesystem", risk_level: "high" },
  { name: "edit_file", description: "Edit an existing file in the managed workspace", category: "filesystem", risk_level: "high" },
  { name: "preview_data_structure", description: "Preview structured data files", category: "data", risk_level: "low" },
];

export function createDocumentToolsPlugin(dependencies: DocumentToolsPluginDependencies): BackendPlugin {
  return {
    manifest: { id: DOCUMENT_TOOLS_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const runtime = await dependencies.runtimeFactory(runtimeContext);
        return {
          capabilities: [provideCapability(DOCUMENT_TOOLS_RUNTIME_CAPABILITY, runtime)],
          ...(runtime.dispose ? { dispose: () => runtime.dispose?.() } : {}),
        };
      });
      context.tools.register(({ agent, pathAccessPolicy, capabilities }) => {
        if (!capabilities) throw new Error("Document tools plugin requires runtime capabilities");
        const runtime = capabilities.require(DOCUMENT_TOOLS_RUNTIME_CAPABILITY);
        return createDocumentTools({
          documentTools: runtime.document,
          agent,
          pathService: pathAccessPolicy,
        });
      }, TOOL_DESCRIPTORS);
    },
  };
}

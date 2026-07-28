import type { BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { DocumentToolsRuntimeCapability } from "./capability.js";

export interface DocumentToolsPluginRuntime extends DocumentToolsRuntimeCapability {
  dispose?(): void;
}

export type DocumentToolsRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => DocumentToolsPluginRuntime | Promise<DocumentToolsPluginRuntime>;

export interface DocumentToolsPluginDependencies {
  runtimeFactory: DocumentToolsRuntimeFactory;
}

import type { BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { ExecutionToolsRuntimeCapability } from "./capability.js";

export interface ExecutionToolsPluginRuntime extends ExecutionToolsRuntimeCapability {
  dispose?(): void;
}

export type ExecutionToolsRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => ExecutionToolsPluginRuntime | Promise<ExecutionToolsPluginRuntime>;

export interface ExecutionToolsPluginDependencies {
  runtimeFactory: ExecutionToolsRuntimeFactory;
}

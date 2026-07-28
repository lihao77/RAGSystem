import type { BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { McpRuntimeCapability } from "./capability.js";

export interface McpPluginLifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface McpPluginRuntime extends McpRuntimeCapability {
  dispose?(): void;
}

export type McpPluginRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => McpPluginRuntime | Promise<McpPluginRuntime>;

export interface McpPluginDependencies {
  runtimeFactory: McpPluginRuntimeFactory;
  lifecycle?: McpPluginLifecycle;
}

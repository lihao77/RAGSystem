import type { HookRegistry } from "@ragsystem/agent-sdk";
import type {
  BackendPluginRuntimeContext,
  BackendPluginRuntimeFactory,
} from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { MemoryRuntimeCapability } from "./capability.js";

export interface MemoryPluginRuntime extends MemoryRuntimeCapability {
  configureHooks(registry: HookRegistry): void;
  dispose?(): void;
}

export type MemoryPluginRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => MemoryPluginRuntime | Promise<MemoryPluginRuntime>;

export interface MemoryPluginLifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface MemoryPluginDependencies {
  runtimeFactory: MemoryPluginRuntimeFactory;
  lifecycle?: MemoryPluginLifecycle;
}

export function asBackendRuntimeFactory(factory: MemoryPluginRuntimeFactory): BackendPluginRuntimeFactory {
  return factory;
}

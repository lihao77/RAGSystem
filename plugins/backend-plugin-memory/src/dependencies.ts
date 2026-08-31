import type {
  BackendContextSourceFactory,
  BackendPluginRuntimeContext,
  BackendPluginRuntimeFactory,
} from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { MemoryRuntimeCapability } from "./capability.js";

export interface MemoryPluginRuntime extends MemoryRuntimeCapability {
  /** 前置记忆前缀 source 工厂（核心上下文组装时实例化；产物排在 history 之前的稳定前缀）。 */
  contextSources: readonly BackendContextSourceFactory[];
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

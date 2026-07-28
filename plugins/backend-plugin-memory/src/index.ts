export { MEMORY_PLUGIN_ID, createMemoryPlugin } from "./plugin.js";
export { MEMORY_RUNTIME_CAPABILITY, type MemoryRuntimeCapability } from "./capability.js";
export {
  MemoryAgentConfigSchema,
  MemoryAgentConfigService,
  MEMORY_SCOPE_METADATA,
  type MemoryAgentConfig,
  type MemoryAgentConfigKey,
  type MemoryAgentConfigStore,
} from "./config.js";
export type {
  MemoryPluginDependencies,
  MemoryPluginLifecycle,
  MemoryPluginRuntime,
  MemoryPluginRuntimeFactory,
} from "./dependencies.js";
export { createLocalMemoryRuntimeFactory } from "./storage/local/runtime.js";
export { createPostgresMemoryRuntimeFactory } from "./storage/postgres/runtime.js";
export { createPostgresMemoryLifecycle } from "./storage/postgres/lifecycle.js";
export type { PostgresMemoryExecutor, PostgresQueryResult } from "./storage/postgres/repository.js";

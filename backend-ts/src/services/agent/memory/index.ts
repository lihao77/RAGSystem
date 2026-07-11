/** memory context source（agent 上下文装配层；store 在 services/stores/memory-store）。 */
export { MemoryIndexContextSource, buildMemoryIndexContextSourceOptions } from "./memory-index-source.js";
export type { MemoryIndexContextSourceOptions } from "./memory-index-source.js";
export { isMemoryEnabled, memoryBaselineKey } from "./memory-prefix.js";

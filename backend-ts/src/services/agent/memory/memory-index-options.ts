import type { MemoryConfig as SystemMemoryConfig } from "../../../contracts/system-config.js";
import { MemoryStore } from "../../stores/memory-store.js";
import type { MemoryIndexContextSourceOptions } from "./memory-index-source.js";

/** Local compatibility builder. SaaS composition should inject its repository directly. */
export function buildMemoryIndexContextSourceOptions(
  memoryConfig: SystemMemoryConfig,
  dataRoot: string,
): MemoryIndexContextSourceOptions {
  return {
    memoryRepository: new MemoryStore({ dataRoot }),
    indexMaxLines: memoryConfig.index_max_lines,
    indexMaxChars: memoryConfig.index_max_chars,
  };
}

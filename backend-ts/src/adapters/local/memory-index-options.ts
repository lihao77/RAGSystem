import type { MemoryConfig as SystemMemoryConfig } from "../../contracts/runtime/system-config.js";
import type { MemoryIndexContextSourceOptions } from "../../services/agent/memory/memory-index-source.js";

/** Local-only defaults for the filesystem memory context adapter. */
export function buildMemoryIndexContextSourceOptions(
  memoryConfig: SystemMemoryConfig,
  _dataRoot: string,
): MemoryIndexContextSourceOptions {
  return {
    indexMaxLines: memoryConfig.index_max_lines,
    indexMaxChars: memoryConfig.index_max_chars,
  };
}

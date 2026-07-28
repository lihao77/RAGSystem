import type { MemoryConfig as SystemMemoryConfig } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import type { MemoryContextSourceOptions } from "@ragsystem/backend-core/services/agent/memory/memory-context-source.js";

/** Local-only defaults for the filesystem memory context adapter. */
export function buildMemoryContextSourceOptions(
  memoryConfig: SystemMemoryConfig,
  _dataRoot: string,
): MemoryContextSourceOptions {
  return {
    indexMaxLines: memoryConfig.index_max_lines,
    indexMaxChars: memoryConfig.index_max_chars,
  };
}

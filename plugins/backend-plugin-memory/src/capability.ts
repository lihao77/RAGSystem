import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { MemoryApplication } from "./services/memory/memory-application.js";
import type { MemoryToolOperations } from "./tools/MemoryExecution.js";

export interface MemoryRuntimeCapability {
  readonly tools: MemoryToolOperations;
  createApplication(input: {
    viewerUserId: string;
    viewerSessionIds: readonly string[] | (() => Promise<readonly string[]>);
  }): MemoryApplication;
}

export const MEMORY_RUNTIME_CAPABILITY = createCapability<MemoryRuntimeCapability>(
  "@ragsystem/backend-plugin-memory/runtime",
);

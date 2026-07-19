import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { MemoryConfig } from "../../../contracts/runtime/system-config.js";
import type { MemoryToolOperations } from "../../../tools/MemoryTools/MemoryExecution.js";
import type { AgentContextSource, SessionMetadataPort } from "../context/types.js";

export interface CreateMemoryContextSourceInput {
  sessions: SessionMetadataPort;
  memory: AgentConfig["memory"];
  agentName: string;
  memoryConfig: MemoryConfig;
  dataRoot: string;
}

/** Deployment-bound Memory consumers used by the shared agent runtime. */
export interface MemoryRuntimeBindings {
  readonly tools: MemoryToolOperations;
  createContextSource(input: CreateMemoryContextSourceInput): AgentContextSource;
}

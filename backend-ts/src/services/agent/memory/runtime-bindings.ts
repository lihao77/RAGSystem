import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { IMemoryCandidateStore } from "../../../contracts/conversation-store/index.js";
import type { MemoryConfig } from "../../../contracts/runtime/system-config.js";
import type { MemoryToolOperations } from "../../../tools/MemoryTools/MemoryExecution.js";
import type { AgentContextSource, SessionMetadataPort } from "../context/types.js";

export interface ExecutionMemoryCandidateListPort {
  listMemoryCandidates(
    input: Parameters<IMemoryCandidateStore["listMemoryCandidates"]>[0],
  ): ReturnType<IMemoryCandidateStore["listMemoryCandidates"]>
    | Promise<ReturnType<IMemoryCandidateStore["listMemoryCandidates"]>>;
}

export interface CreateMemoryContextSourceInput {
  sessions: SessionMetadataPort & Partial<ExecutionMemoryCandidateListPort>;
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

/** 空实现顶位 source（memory 未配置时占位，对齐 backend-ts）。 */
import type { AgentContextContribution, AgentContextSource, ResolvedAgentContextRequest } from "./types.js";

export class EmptyMemoryContextSource implements AgentContextSource {
  readonly name = "empty_memory";
  build(_request: ResolvedAgentContextRequest): AgentContextContribution {
    return { conversation: [], metadata: { enabled: false } };
  }
}

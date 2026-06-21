import type { AgentContextContribution, AgentContextSource } from "./types.js";

export class EmptyMemoryContextSource implements AgentContextSource {
  readonly name = "memory";

  build(): AgentContextContribution {
    return {
      conversation: [],
      metadata: {
        status: "not_loaded",
      },
    };
  }
}

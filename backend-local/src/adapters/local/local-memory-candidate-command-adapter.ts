import type { MemoryCandidateCommandPort } from "@ragsystem/backend-core/contracts/memory-store/index.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

/** Adapts Local's synchronous candidate store to the shared Promise-only command port. */
export class LocalMemoryCandidateCommandAdapter implements MemoryCandidateCommandPort {
  constructor(private readonly candidates: Pick<ConversationStore, "createMemoryCandidate">) {}

  async createMemoryCandidate(
    input: Parameters<MemoryCandidateCommandPort["createMemoryCandidate"]>[0],
  ) {
    return this.candidates.createMemoryCandidate(input);
  }
}

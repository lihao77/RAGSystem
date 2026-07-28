import type { MemoryCandidateCommandPort } from "../../contracts/memory-store/index.js";
import type { LocalCandidateStore } from "./memory-application.js";

/** Adapts Local's synchronous candidate store to the shared Promise-only command port. */
export class LocalMemoryCandidateCommandAdapter implements MemoryCandidateCommandPort {
  constructor(private readonly candidates: Pick<LocalCandidateStore, "createMemoryCandidate">) {}

  async createMemoryCandidate(
    input: Parameters<MemoryCandidateCommandPort["createMemoryCandidate"]>[0],
  ) {
    return this.candidates.createMemoryCandidate(input);
  }
}

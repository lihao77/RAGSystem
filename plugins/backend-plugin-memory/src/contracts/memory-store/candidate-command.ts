import type {
  CreateMemoryCandidateInput,
  MemoryCandidateRecord,
} from "../local-candidates.js";

/** Promise-only command boundary for proposing shared Memory mutations. */
export interface MemoryCandidateCommandPort {
  createMemoryCandidate(input: CreateMemoryCandidateInput): Promise<MemoryCandidateRecord>;
}

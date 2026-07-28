import type { SessionHistoryPort } from "@ragsystem/backend-core/contracts/session/session-history.js";
import type { FileHistoryService } from "./files/file-history-service.js";

/** Adapts synchronous filesystem snapshots to the shared async session history port. */
export class LocalSessionHistoryAdapter implements SessionHistoryPort {
  constructor(private readonly history: FileHistoryService) {}

  async cleanup(sessionId: string) { this.history.cleanup(sessionId); }
  async makeSnapshot(sessionId: string, messageSeq: number) {
    return this.history.makeSnapshot(sessionId, messageSeq);
  }
  async hasSnapshots(sessionId: string) { return this.history.hasSnapshots(sessionId); }
  async rewind(sessionId: string, targetSeq: number) { this.history.rewind(sessionId, targetSeq); }
}

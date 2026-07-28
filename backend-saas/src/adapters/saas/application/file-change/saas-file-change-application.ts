import type { FileChangeApplication } from "@ragsystem/backend-core/contracts/application/file-change-application.js";
import type { AsyncFileHistoryStore } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import { FileChangeService } from "@ragsystem/backend-core/services/sessions/file-change-service.js";

export class SaaSFileChangeApplication implements FileChangeApplication {
  private readonly service: FileChangeService;

  constructor(history: AsyncFileHistoryStore) {
    this.service = new FileChangeService(history);
  }

  getLatest(sessionId: string, messageSeq?: number) { return this.service.getLatest(sessionId, messageSeq); }
}

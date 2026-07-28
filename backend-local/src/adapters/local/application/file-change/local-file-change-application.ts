import type { FileChangeApplication } from "@ragsystem/backend-core/contracts/application/file-change-application.js";
import { FileChangeService } from "@ragsystem/backend-core/services/sessions/file-change-service.js";
import type { FileHistoryService } from "../../files/file-history-service.js";
import { LocalFileChangeHistoryAdapter } from "../../files/local-file-change-history-adapter.js";

export class LocalFileChangeApplication implements FileChangeApplication {
  private readonly service: FileChangeService;

  constructor(history: FileHistoryService) {
    this.service = new FileChangeService(new LocalFileChangeHistoryAdapter(history));
  }

  async getLatest(sessionId: string, messageSeq?: number) { return this.service.getLatest(sessionId, messageSeq); }
}

import type { FileChangeApplication } from "../../../../contracts/application/file-change-application.js";
import type { AsyncFileHistoryStore } from "../../../../contracts/file-history-store/index.js";
import { AsyncFileChangeService } from "../../../../services/sessions/file-change-service.js";

export class SaaSFileChangeApplication implements FileChangeApplication {
  private readonly service: AsyncFileChangeService;

  constructor(history: AsyncFileHistoryStore) {
    this.service = new AsyncFileChangeService(history);
  }

  getLatest(sessionId: string) { return this.service.getLatest(sessionId); }
}

import type { FileChangeApplication } from "../../../../contracts/application/file-change-application.js";
import type { IFileHistoryStore } from "../../../../contracts/file-history-store/index.js";
import { FileChangeService } from "../../../../services/sessions/file-change-service.js";
import { LocalFileChangeHistoryAdapter } from "../../files/local-file-change-history-adapter.js";

export class LocalFileChangeApplication implements FileChangeApplication {
  private readonly service: FileChangeService;

  constructor(history: IFileHistoryStore) {
    this.service = new FileChangeService(new LocalFileChangeHistoryAdapter(history));
  }

  getLatest(sessionId: string) { return this.service.getLatest(sessionId); }
}

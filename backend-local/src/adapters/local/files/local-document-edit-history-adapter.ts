import type { DocumentEditHistoryPort } from "@ragsystem/backend-core/contracts/runtime/tool-ports.js";
import type { FileHistoryService } from "./file-history-service.js";

/** Adapts the synchronous local file-history implementation to the document tool port. */
export class LocalDocumentEditHistoryAdapter implements DocumentEditHistoryPort {
  constructor(private readonly history: FileHistoryService) {}

  async trackEdit(sessionId: string | null | undefined, filePath: string): Promise<void> {
    this.history.trackEdit(sessionId, filePath);
  }
}

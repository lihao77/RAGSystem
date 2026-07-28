import type { ConversationStore } from "./sqlite/conversation-store/index.js";
import type {
  CompressionHistoryPort,
  InsertCompressionMessageInput,
} from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import type { MessageInfo } from "@ragsystem/backend-core/contracts/session/session.js";

/** Async boundary for Local's synchronous SQLite conversation store. */
export class LocalCompressionHistoryAdapter implements CompressionHistoryPort {
  constructor(private readonly messages: Pick<ConversationStore, "getRecentMessages" | "insertCompressionMessage">) {}

  async getRecentMessages(
    sessionId: string,
    limit?: number,
    threadKey?: string | null,
  ): Promise<MessageInfo[]> {
    return this.messages.getRecentMessages(sessionId, limit, threadKey);
  }

  async insertCompressionMessage(
    input: InsertCompressionMessageInput,
  ): Promise<MessageInfo> {
    return this.messages.insertCompressionMessage(input);
  }
}

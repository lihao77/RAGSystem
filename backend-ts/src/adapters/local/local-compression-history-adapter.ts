import type { IMessageStore } from "../../contracts/conversation-store/index.js";
import type {
  CompressionHistoryPort,
  InsertCompressionMessageInput,
} from "../../contracts/runtime/core-runtime-ports.js";
import type { MessageInfo } from "../../contracts/session/session.js";

/** Async boundary for Local's synchronous SQLite conversation store. */
export class LocalCompressionHistoryAdapter implements CompressionHistoryPort {
  constructor(private readonly messages: IMessageStore) {}

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

import type { AgentMailboxStorePort, ListPendingAgentMailboxInput } from "@ragsystem/backend-core/contracts/storage/agent-mailbox-repository.js";

import type { ConversationStore } from "./sqlite/conversation-store/index.js";

/** Promise-only deployment adapter over Local SQLite's durable Agent mailbox. */
export class LocalAgentMailboxStoreAdapter implements AgentMailboxStorePort {
  private readonly mailbox: ConversationStore["agentMailbox"];

  constructor(store: Pick<ConversationStore, "agentMailbox">) {
    this.mailbox = store.agentMailbox;
  }

  enqueue(input: Parameters<AgentMailboxStorePort["enqueue"]>[0]) {
    return this.mailbox.enqueue(input);
  }

  get(sessionId: string, messageId: string) {
    return this.mailbox.get(sessionId, messageId);
  }

  listPending(input: ListPendingAgentMailboxInput) {
    return this.mailbox.listPending(input);
  }

  claim(input: Parameters<AgentMailboxStorePort["claim"]>[0]) {
    return this.mailbox.claim(input);
  }

  ack(input: Parameters<AgentMailboxStorePort["ack"]>[0]) {
    return this.mailbox.ack(input);
  }

  release(input: Parameters<AgentMailboxStorePort["release"]>[0]) {
    return this.mailbox.release(input);
  }

  expire(input?: Parameters<AgentMailboxStorePort["expire"]>[0]) {
    return this.mailbox.expire(input);
  }
}

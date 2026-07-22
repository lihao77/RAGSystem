import type {
  IChildAgentStore,
  IMessageStore,
  IRunStore,
} from "../../contracts/conversation-store/index.js";
import type { AgentDelegationStorePort } from "../../contracts/runtime/core-runtime-ports.js";

type LocalDelegationStore = IMessageStore & IRunStore & IChildAgentStore;

/** Adapts Local's synchronous conversation store to the shared Promise-only port. */
export class LocalAgentDelegationStoreAdapter implements AgentDelegationStorePort {
  constructor(private readonly store: LocalDelegationStore) {}

  async addMessage(input: Parameters<AgentDelegationStorePort["addMessage"]>[0]) {
    return this.store.addMessage(input);
  }

  async getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null) {
    return this.store.getRecentMessages(sessionId, limit, threadKey);
  }

  async getRun(sessionId: string, runId: string) {
    return this.store.getRun(sessionId, runId);
  }

  async updateRunStatus(
    runId: string,
    sessionId: string,
    status: string,
    finalMessageId?: string | null,
  ) {
    return this.store.updateRunStatus(runId, sessionId, status, finalMessageId);
  }

  async createChildAgent(input: Parameters<AgentDelegationStorePort["createChildAgent"]>[0]) {
    return this.store.createChildAgent(input);
  }

  async findChildAgentByCreator(
    input: Parameters<AgentDelegationStorePort["findChildAgentByCreator"]>[0],
  ) {
    return this.store.findChildAgentByCreator(input);
  }

  async getChildAgent(sessionId: string, childAgentId: string) {
    return this.store.getChildAgent(sessionId, childAgentId);
  }

  async listChildAgents(input: Parameters<AgentDelegationStorePort["listChildAgents"]>[0]) {
    return this.store.listChildAgents(input);
  }

  async updateChildAgentLastRun(
    input: Parameters<AgentDelegationStorePort["updateChildAgentLastRun"]>[0],
  ) {
    return this.store.updateChildAgentLastRun(input);
  }
}

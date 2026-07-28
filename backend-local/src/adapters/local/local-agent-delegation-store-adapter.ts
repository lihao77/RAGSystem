import type {
  AddMessageInput,
  CreateChildAgentInput,
  FindChildAgentByCreatorInput,
  ListChildAgentsInput,
  UpdateChildAgentLastRunInput,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { AgentDelegationStorePort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

type LocalDelegationStore = Pick<ConversationStore,
  "getSession" | "addMessage" | "getRecentMessages" | "getRun" | "updateRunStatus" |
  "createChildAgent" | "findChildAgentByCreator" | "getChildAgent" |
  "listChildAgents" | "updateChildAgentLastRun">;

/** Adapts Local's synchronous conversation store to the shared Promise-only port. */
export class LocalAgentDelegationStoreAdapter implements AgentDelegationStorePort {
  constructor(private readonly store: LocalDelegationStore) {}

  async getSession(sessionId: string) {
    return this.store.getSession(sessionId);
  }

  async addMessage(input: AddMessageInput) {
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

  async createChildAgent(input: CreateChildAgentInput) {
    return this.store.createChildAgent(input);
  }

  async findChildAgentByCreator(
    input: FindChildAgentByCreatorInput,
  ) {
    return this.store.findChildAgentByCreator(input);
  }

  async getChildAgent(sessionId: string, childAgentId: string) {
    return this.store.getChildAgent(sessionId, childAgentId);
  }

  async listChildAgents(input: ListChildAgentsInput) {
    return this.store.listChildAgents(input);
  }

  async updateChildAgentLastRun(
    input: UpdateChildAgentLastRunInput,
  ) {
    return this.store.updateChildAgentLastRun(input);
  }
}

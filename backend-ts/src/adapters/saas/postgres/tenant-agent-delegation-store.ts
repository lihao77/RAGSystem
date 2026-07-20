import type { AgentDelegationStorePort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { TenantId } from "../../../identity/types.js";
import type { AddMessageInput } from "../../../contracts/conversation-store/index.js";
import type { PostgresConversationRepository } from "./conversation-repository.js";
import type { PostgresRunRepository } from "./run-repository.js";
import { PostgresChildAgentRepository } from "./child-agent-repository.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

/**
 * Adapter used by the shared delegation service in SaaS.
 *
 * The service still has Local's value-oriented method shape, while this adapter
 * routes every operation to tenant-scoped PostgreSQL repositories. It deliberately
 * performs a session ownership check before conversation calls because those
 * repository methods are keyed by globally unique session ids for compatibility.
 */
export class TenantBoundPostgresAgentDelegationStore implements AgentDelegationStorePort {
  private readonly children: PostgresChildAgentRepository;

  constructor(
    private readonly tenantId: TenantId,
    executor: PostgresMemoryExecutor,
    private readonly conversation: PostgresConversationRepository,
    private readonly runs: PostgresRunRepository,
  ) {
    this.children = new PostgresChildAgentRepository(executor);
  }

  async addMessage(input: AddMessageInput): Promise<Awaited<ReturnType<PostgresConversationRepository["addMessage"]>>> {
    await this.children.assertTenantSession(this.tenantId, input.sessionId);
    return this.conversation.addMessage(input);
  }

  async getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<Awaited<ReturnType<PostgresConversationRepository["getRecentMessages"]>>> {
    await this.children.assertTenantSession(this.tenantId, sessionId);
    return this.conversation.getRecentMessages(sessionId, limit, threadKey);
  }

  getRun(sessionId: string, runId: string): ReturnType<PostgresRunRepository["getRun"]> {
    return this.runs.getRun(this.tenantId, sessionId, runId);
  }

  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): ReturnType<PostgresRunRepository["updateRunStatus"]> {
    return this.runs.updateRunStatus(this.tenantId, runId, sessionId, status, finalMessageId);
  }

  createChildAgent(input: Parameters<AgentDelegationStorePort["createChildAgent"]>[0]): ReturnType<PostgresChildAgentRepository["createChildAgent"]> {
    return this.children.createChildAgent(this.tenantId, input);
  }

  findChildAgentByCreator(input: Parameters<AgentDelegationStorePort["findChildAgentByCreator"]>[0]): ReturnType<PostgresChildAgentRepository["findChildAgentByCreator"]> {
    return this.children.findChildAgentByCreator(this.tenantId, input);
  }

  getChildAgent(sessionId: string, childAgentId: string): ReturnType<PostgresChildAgentRepository["getChildAgent"]> {
    return this.children.getChildAgent(this.tenantId, sessionId, childAgentId);
  }

  listChildAgents(input: Parameters<AgentDelegationStorePort["listChildAgents"]>[0]): ReturnType<PostgresChildAgentRepository["listChildAgents"]> {
    return this.children.listChildAgents(this.tenantId, input);
  }

  updateChildAgentLastRun(input: Parameters<AgentDelegationStorePort["updateChildAgentLastRun"]>[0]): ReturnType<PostgresChildAgentRepository["updateChildAgentLastRun"]> {
    return this.children.updateChildAgentLastRun(this.tenantId, input);
  }
}

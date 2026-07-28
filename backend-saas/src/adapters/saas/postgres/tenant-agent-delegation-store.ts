import type { AgentDelegationStorePort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type {
  AddMessageInput,
  ChildAgentInfo,
  CreateChildAgentInput,
  FindChildAgentByCreatorInput,
  ListChildAgentsInput,
  RunInfo,
  UpdateChildAgentLastRunInput,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { MessageInfo } from "@ragsystem/backend-core/contracts/session/session.js";
import type { PostgresConversationRepository } from "./conversation-repository.js";
import type { PostgresRunRepository } from "./run-repository.js";
import { PostgresChildAgentRepository } from "./child-agent-repository.js";
import type { PostgresExecutor } from "./postgres-executor.js";

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
    executor: PostgresExecutor,
    private readonly conversation: PostgresConversationRepository,
    private readonly runs: PostgresRunRepository,
  ) {
    this.children = new PostgresChildAgentRepository(executor);
  }

  async getSession(sessionId: string) {
    const session = await this.conversation.getSession(sessionId);
    return session?.tenant_id === this.tenantId ? session : null;
  }

  async addMessage(input: AddMessageInput): Promise<MessageInfo> {
    await this.children.assertTenantSession(this.tenantId, input.sessionId);
    return this.conversation.addMessage(input);
  }

  async getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]> {
    await this.children.assertTenantSession(this.tenantId, sessionId);
    return this.conversation.getRecentMessages(sessionId, limit, threadKey);
  }

  getRun(sessionId: string, runId: string): Promise<RunInfo | null> {
    return this.runs.getRun(this.tenantId, sessionId, runId);
  }

  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): Promise<boolean> {
    return this.runs.updateRunStatus(this.tenantId, runId, sessionId, status, finalMessageId);
  }

  createChildAgent(input: CreateChildAgentInput): Promise<ChildAgentInfo> {
    return this.children.createChildAgent(this.tenantId, input);
  }

  findChildAgentByCreator(input: FindChildAgentByCreatorInput): Promise<ChildAgentInfo | null> {
    return this.children.findChildAgentByCreator(this.tenantId, input);
  }

  getChildAgent(sessionId: string, childAgentId: string): Promise<ChildAgentInfo | null> {
    return this.children.getChildAgent(this.tenantId, sessionId, childAgentId);
  }

  listChildAgents(input: ListChildAgentsInput): Promise<{ items: ChildAgentInfo[]; total: number }> {
    return this.children.listChildAgents(this.tenantId, input);
  }

  updateChildAgentLastRun(input: UpdateChildAgentLastRunInput): Promise<boolean> {
    return this.children.updateChildAgentLastRun(this.tenantId, input);
  }
}

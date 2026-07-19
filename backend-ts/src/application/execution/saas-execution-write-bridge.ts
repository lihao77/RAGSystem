import type { AddMessageInput } from "../../contracts/conversation-store/types.js";
import type { AsyncConversationRepository, AsyncRunStore } from "../../contracts/async-persistence-ports.js";
import { createTenantId } from "../../identity/types.js";

export interface SaaSExecutionWriteBridgeInput {
  tenantId: string;
  sessionId: string;
  runId: string;
  userId?: string | null;
  taskSummary?: string | null;
  requestId?: string | null;
  agentName?: string | null;
  threadKey?: string | null;
  status: "completed" | "failed" | "interrupted" | "suspended";
  answer?: string | null;
}

/**
 * Records the execution boundary in the SaaS stores.
 *
 * The Local runtime still owns the synchronous event stream. This bridge is
 * intentionally small and idempotent so the SaaS runtime has a durable
 * session/run/final-message record while the event persister is migrated.
 */
export class SaaSExecutionWriteBridge {
  constructor(
    private readonly conversation: AsyncConversationRepository,
    private readonly runs: AsyncRunStore,
  ) {}

  async record(input: SaaSExecutionWriteBridgeInput): Promise<void> {
    await this.conversation.createSession(createTenantId(input.tenantId), input.sessionId, input.userId ?? null);
    await this.runs.createRun({
      tenantId: input.tenantId,
      runId: input.runId,
      sessionId: input.sessionId,
      entrypoint: "agent",
      status: "running",
      taskSummary: input.taskSummary ?? "",
      requestId: input.requestId ?? null,
      userId: input.userId ?? null,
      agentName: input.agentName ?? null,
      threadKey: input.threadKey ?? "root",
    });

    let finalMessageId: string | null = null;
    if (input.status === "completed" && input.answer != null) {
      finalMessageId = `${input.runId}:final`;
      const message: AddMessageInput = {
        messageId: finalMessageId,
        sessionId: input.sessionId,
        role: "assistant",
        content: input.answer,
        threadKey: input.threadKey ?? "root",
        metadata: { run_id: input.runId, saas_boundary: true },
      };
      await this.conversation.addMessage(message);
    }
    await this.runs.updateRunStatus(input.tenantId, input.runId, input.sessionId, input.status, finalMessageId);
  }
}

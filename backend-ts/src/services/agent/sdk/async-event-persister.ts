import { extractText } from "@ragsystem/agent-llm";
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { KernelEvent } from "@ragsystem/agent-sdk";
import type { AddMessageInput } from "../../../contracts/conversation-store/types.js";
import type { AsyncConversationRepository } from "../../../adapters/saas/postgres/conversation-repository.js";
import type { AsyncRunStore } from "../../../adapters/saas/postgres/run-repository.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import type { TenantId } from "../../../identity/types.js";

export interface AsyncPersisterRunContext {
  tenantId: TenantId;
  sessionId: string;
  runId: string;
  threadKey: string;
  agentName: string;
  providerType?: string;
  executionKind?: string;
  taskSummary?: string;
  requestId?: string | null;
  userId?: string | null;
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  messageMetadata?: Record<string, unknown> | null;
}

export interface AsyncFinalMessageInput { id?: string; content: string; metadata?: Record<string, unknown> }

/** Async SaaS event persister. It is intentionally separate from Local's sync transaction persister. */
export class AsyncKernelEventPersister {
  private finalMessageId: string | null = null;

  constructor(
    private readonly conversation: Pick<AsyncConversationRepository, "createSession" | "addMessage" | "getMessageById">,
    private readonly runs: Pick<AsyncRunStore, "createRun" | "updateRunStatus" | "getRun">,
    private readonly ctx: AsyncPersisterRunContext,
  ) {}

  async startRun(): Promise<void> {
    await this.conversation.createSession(this.ctxTenant(), this.ctx.sessionId, this.ctx.userId ?? null);
    await this.runs.createRun({
      runId: this.ctx.runId, sessionId: this.ctx.sessionId, status: "running", agentName: this.ctx.agentName,
      threadKey: this.ctx.threadKey, ...(this.ctx.executionKind ? { entrypoint: this.ctx.executionKind } : {}),
      ...(this.ctx.taskSummary !== undefined ? { taskSummary: this.ctx.taskSummary } : {}),
      ...(this.ctx.requestId !== undefined ? { requestId: this.ctx.requestId } : {}),
      ...(this.ctx.userId !== undefined ? { userId: this.ctx.userId } : {}),
      ...(this.ctx.parentRunId !== undefined ? { parentRunId: this.ctx.parentRunId } : {}),
      ...(this.ctx.parentCallId !== undefined ? { parentCallId: this.ctx.parentCallId } : {}),
      ...(this.ctx.childAgentId !== undefined ? { childAgentId: this.ctx.childAgentId } : {}),
    });
  }

  async persist(event: KernelEvent): Promise<void> {
    if (event.type === "tool_result") {
      await this.conversation.addMessage({ sessionId: this.ctx.sessionId, role: "tool", content: event.observation, threadKey: this.ctx.threadKey, toolCallId: event.toolCallId, name: event.toolName, metadata: this.messageMeta(event.round, MSG_TYPE.OBSERVATION) });
    } else if (event.type === "assistant_intermediate") {
      await this.persistAssistant(event.message, event.round);
    }
  }

  async finalize(status: "completed" | "failed" | "interrupted" | "suspended", finalMessage: AsyncFinalMessageInput | null): Promise<void> {
    if (status === "completed" && finalMessage) {
      const message = await this.conversation.addMessage({ sessionId: this.ctx.sessionId, role: "assistant", content: finalMessage.content, threadKey: this.ctx.threadKey, ...(finalMessage.id ? { messageId: finalMessage.id } : {}), metadata: { ...this.messageMeta(0, MSG_TYPE.ASSISTANT_FINAL), ...(this.ctx.messageMetadata ?? {}), ...(finalMessage.metadata ?? {}) } });
      this.finalMessageId = message.id;
    }
    await this.runs.updateRunStatus(this.ctx.runId, this.ctx.sessionId, status, this.finalMessageId);
  }

  async resolveFinalMessage(): Promise<{ id: string; seq: number; content: string } | null> {
    const run = await this.runs.getRun(this.ctx.sessionId, this.ctx.runId);
    if (!run?.final_message_id) return null;
    const message = await this.conversation.getMessageById(this.ctx.sessionId, run.final_message_id);
    return message ? { id: message.id, seq: message.seq, content: message.content } : null;
  }

  private async persistAssistant(message: ChatMessage, round: number): Promise<void> {
    const input: AddMessageInput = { sessionId: this.ctx.sessionId, role: "assistant", content: extractText(message.content), threadKey: this.ctx.threadKey, metadata: this.messageMeta(round, MSG_TYPE.INTENT) };
    if (message.tool_calls) input.toolCalls = message.tool_calls as AddMessageInput["toolCalls"];
    await this.conversation.addMessage(input);
  }

  private messageMeta(round: number, msgType: string): Record<string, unknown> {
    return { agent_name: this.ctx.agentName, run_id: this.ctx.runId, thread_key: this.ctx.threadKey, execution_kind: this.ctx.executionKind, round: round + 1, msg_type: msgType, visible_to_user: true };
  }

  private ctxTenant() {
    // Async repository requires a tenant id; runtime composition supplies it through the session boundary.
    // The session is created by the SaaS execution bridge before this persister is used.
    return this.ctx.tenantId;
  }
}

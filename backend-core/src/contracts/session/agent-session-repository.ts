import type { RunStepInfo } from "../common.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type {
  CreateSessionRecordInput,
  MessageInfo,
  SessionFacetCounts,
  SessionInfo,
  SessionListProjectionPage,
  SessionListQuery,
  SessionMessageListSnapshot,
} from "./session.js";

export interface AgentSessionMessageInput {
  sessionId: string;
  role: MessageInfo["role"];
  content: string;
  contentParts: MessageContentPart[];
  metadata?: Record<string, unknown>;
  toolCalls?: MessageInfo["tool_calls"];
  toolCallId?: string | undefined;
  name?: string | undefined;
  messageId?: string;
  threadKey?: string;
  childAgentId?: string | null;
}

export interface AgentSessionMessageUpdate {
  messageId: string;
  content?: string | null;
  contentParts?: MessageContentPart[] | null;
  metadata?: Record<string, unknown> | null;
  sessionId?: string | null;
  roleFilter?: MessageInfo["role"] | null;
}

export interface AgentSessionRunRecord {
  run_id: string;
  parent_run_id: string | null;
  created_at: string;
}

/** Promise-only persistence boundary used by the Local agent session application. */
export interface AgentSessionRepositoryPort {
  createSession(input: CreateSessionRecordInput): Promise<void>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  deleteSession(sessionId: string): Promise<boolean>;
  listSessions(input: SessionListQuery): Promise<SessionListProjectionPage>;
  listSessionFacets(input: Pick<SessionListQuery, "tenantId" | "access">): Promise<SessionFacetCounts>;

  addMessage(input: AgentSessionMessageInput): Promise<MessageInfo>;
  listMessages(sessionId: string, limit: number, offset: number): Promise<SessionMessageListSnapshot>;
  getMessageBySeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  getMessageById(sessionId: string, messageId: string): Promise<MessageInfo | null>;
  getFirstMessageAfterSeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  listMessagesAfterSeq(sessionId: string, seq: number, limit: number): Promise<MessageInfo[]>;
  listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit: number): Promise<MessageInfo[]>;
  deleteMessagesAfter(
    sessionId: string,
    input: { afterSeq?: number | null; afterMessageId?: string | null },
  ): Promise<number>;
  updateMessage(input: AgentSessionMessageUpdate): Promise<boolean>;

  listRuns(sessionId: string, limit: number): Promise<{ items: AgentSessionRunRecord[]; total: number }>;
  listRunSteps(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): Promise<RunStepInfo[]>;
}

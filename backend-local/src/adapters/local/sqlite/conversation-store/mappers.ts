import type { RunStepInfo } from "@ragsystem/backend-core/contracts/common.js";
import type { MessageInfo, SessionInfo, SessionListProjection } from "@ragsystem/backend-core/contracts/session/session.js";
import { parseJsonObject, sqliteTimestampToIso } from "./helpers.js";
import { decodeChatFields } from "@ragsystem/backend-core/contracts/conversation-store/chat-message-codec.js";
import { MessageContentPartSchema } from "@ragsystem/agent-protocol";
import type { ChildAgentInfo, ResourceInfo, RunInfo } from "@ragsystem/backend-core/contracts/conversation-store/types.js";
import type {
  ChildAgentRow,
  MessageRow,
  ResourceRow,
  RunRow,
  RunStepRow,
  SessionListProjectionRow,
  SessionRow,
} from "./types.js";

export function rowToSession(row: SessionRow): SessionInfo {
  return {
    session_id: row.session_id,
    tenant_id: row.tenant_id,
    owner_user_id: row.owner_user_id,
    visibility: row.visibility,
    origin_type: row.origin_type,
    origin_id: row.origin_id,
    origin_channel: row.origin_channel,
    workspace_id: row.workspace_id,
    permission_mode: row.permission_mode,
    metadata: parseJsonObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rowToSessionListProjection(row: SessionListProjectionRow): SessionListProjection {
  return { ...row, activity_at: sqliteTimestampToIso(row.activity_at) };
}

export function rowToMessage(row: MessageRow): MessageInfo {
  const metadata = parseJsonObject(row.metadata);
  const parsedContentParts = MessageContentPartSchema.array().safeParse(JSON.parse(row.content_parts));
  if (!parsedContentParts.success) {
    throw new Error(`Invalid content_parts for message ${row.id}`);
  }
  return {
    seq: row.seq,
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    content_parts: parsedContentParts.data,
    metadata,
    thread_key: row.thread_key ?? "root",
    child_agent_id: row.child_agent_id,
    created_at: row.created_at,
    ...decodeChatFields(metadata),
  };
}

export function rowToChildAgent(row: ChildAgentRow): ChildAgentInfo {
  return {
    child_agent_id: row.child_agent_id,
    session_id: row.session_id,
    agent_name: row.agent_name,
    thread_key: row.thread_key,
    status: row.status,
    created_seq: row.created_seq,
    created_by_run_id: row.created_by_run_id,
    created_by_call_id: row.created_by_call_id,
    parent_run_id: row.parent_run_id,
    parent_call_id: row.parent_call_id,
    last_run_id: row.last_run_id,
    metadata: parseJsonObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rowToRun(row: RunRow): RunInfo {
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    tenant_id: row.tenant_id,
    entrypoint: row.entrypoint,
    status: row.status,
    task_summary: row.task_summary,
    terminal_reason: row.terminal_reason,
    request_id: row.request_id,
    user_id: row.user_id,
    agent_name: row.agent_name,
    agent_call_id: row.agent_call_id,
    lineage_parent_call_id: row.lineage_parent_call_id,
    agent_display_name: row.agent_display_name,
    lease_root_run_id: row.lease_root_run_id,
    thread_key: row.thread_key,
    parent_run_id: row.parent_run_id,
    parent_call_id: row.parent_call_id,
    child_agent_id: row.child_agent_id,
    final_message_id: row.final_message_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rowToResource(row: ResourceRow): ResourceInfo {
  return {
    resource_id: row.resource_id,
    session_id: row.session_id,
    run_id: row.run_id,
    path: row.path,
    resource_type: row.resource_type,
    sub_type: row.sub_type,
    title: row.title,
    scope: row.scope,
    source_tool: row.source_tool,
  };
}

export function rowToRunStep(row: RunStepRow, resourceRefs: Array<{ resource_id: string }> = []): RunStepInfo {
  const payload = parseJsonObject(row.payload);
  payload.resource_refs = resourceRefs;
  return {
    id: row.id,
    run_id: row.run_id,
    ...(row.event_id ? { event_id: row.event_id } : {}),
    session_id: row.session_id,
    message_id: row.message_id,
    step_order: row.step_order,
    step_type: row.step_type,
    payload,
    created_at: row.created_at,
  };
}

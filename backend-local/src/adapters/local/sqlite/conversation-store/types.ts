import type {
  MessageInfo,
  SessionOriginChannel,
  SessionOriginType,
  SessionVisibility,
} from "@ragsystem/backend-core/contracts/session/session.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";

/**
 * conversation-store 实现层内部物理行映射（SQLite 行 ↔ 内存对象）。
 * 仅 services/conversation-store 内部使用；对外领域 DTO（*Info/Stats/*Input/事务）
 * 见 contracts/conversation-store/。*Row 绝不上契约——身份证只暴露 *Info。
 */

export interface MessageRow {
  seq: number;
  id: string;
  session_id: string;
  role: MessageInfo["role"];
  content: string;
  content_parts: string;
  metadata: string | null;
  thread_key: string | null;
  child_agent_id: string | null;
  created_at: string;
}

export interface SessionRow {
  session_id: string;
  tenant_id: TenantId;
  owner_user_id: string | null;
  visibility: SessionVisibility;
  origin_type: SessionOriginType;
  origin_id: string | null;
  origin_channel: SessionOriginChannel;
  workspace_id: string | null;
  permission_mode: PermissionMode | null;
  team_snapshot: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionListProjectionRow {
  session_id: string;
  tenant_id: TenantId;
  owner_user_id: string | null;
  visibility: SessionVisibility;
  origin_type: SessionOriginType;
  origin_id: string | null;
  origin_channel: SessionOriginChannel;
  workspace_id: string | null;
  title: string;
  first_message: string;
  last_message: string;
  activity_at: string;
  unread_count: number;
}

export interface RunStepRow {
  id: number;
  run_id: string;
  event_id?: string | null;
  session_id: string;
  step_order: number;
  step_type: string;
  payload: string | null;
  created_at: string;
}

export interface RunRow {
  run_id: string;
  session_id: string;
  tenant_id: TenantId;
  entrypoint: string | null;
  status: string;
  task_summary: string | null;
  terminal_reason: string | null;
  request_id: string | null;
  user_id: string | null;
  agent_name: string | null;
  agent_call_id: string;
  lineage_parent_call_id: string | null;
  agent_display_name: string;
  lease_root_run_id: string;
  thread_key: string;
  parent_run_id: string | null;
  parent_call_id: string | null;
  child_agent_id: string | null;
  final_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceRow {
  resource_id: string;
  session_id: string;
  run_id: string | null;
  path: string;
  resource_type: string;
  sub_type: string | null;
  title: string | null;
  scope: string;
  source_tool: string | null;
}

export interface ChildAgentRow {
  child_agent_id: string;
  session_id: string;
  agent_name: string;
  thread_key: string;
  status: string;
  parent_participant_id: string | null;
  created_seq: number | null;
  created_by_run_id: string | null;
  created_by_call_id: string | null;
  parent_run_id: string | null;
  parent_call_id: string | null;
  last_run_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export type SqlInputValue = string | number | bigint | Uint8Array | null;

import type { MessageInfo } from "../../../contracts/session.js";

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
  metadata: string | null;
  thread_key: string | null;
  child_agent_id: string | null;
  created_at: string;
}

export interface SessionRow {
  session_id: string;
  user_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionListRow extends SessionRow {
  last_content: string | null;
  last_created_at: string | null;
  first_content: string | null;
}

export interface RunStepRow {
  id: number;
  run_id: string;
  session_id: string;
  message_id: string | null;
  step_order: number;
  step_type: string;
  payload: string | null;
  created_at: string;
}

export interface RunRow {
  run_id: string;
  session_id: string;
  entrypoint: string | null;
  status: string;
  task_summary: string | null;
  request_id: string | null;
  user_id: string | null;
  agent_name: string | null;
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

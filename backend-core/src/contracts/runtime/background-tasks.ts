import type { ClientEventPublisherPort } from "./core-runtime-ports.js";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTask {
  task_id: string;
  description: string;
  output_path: string;
  started_at: number;
  status: BackgroundTaskStatus;
  return_code: number | null;
  error: string | null;
  expires_at: number | null;
  run_id: string | null;
  owner_task_id: string | null;
  session_id: string | null;
  /** 发起者分支（§10.4 第六轮）：完成通知的路由目标；null 视为 root（历史行兼容）。 */
  initiator_thread_key: string | null;
  initiator_child_agent_id: string | null;
  completed_at: number | null;
  result_type: string | null;
  kind: string;
  cancel_supported: boolean;
}

export interface SpawnBashInput {
  command: string;
  bashExecutable: string | null;
  cwd: string;
  outputDir: string;
  description?: string | null;
  env?: Record<string, string | undefined> | undefined;
  maxRuntimeSeconds?: number | null | undefined;
  clientEvents?: ClientEventPublisherPort | null | undefined;
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  ownerTaskId?: string | null | undefined;
  /** 发起者分支（§10.4 第六轮）：完成通知路由给发起工具调用的线程。 */
  initiatorThreadKey?: string | null | undefined;
  initiatorChildAgentId?: string | null | undefined;
}

export interface BackgroundTaskExecutionContext {
  taskId: string;
  signal: AbortSignal;
}

export interface RunCallableInput {
  outputDir: string;
  description?: string | null | undefined;
  run: (context: BackgroundTaskExecutionContext) => unknown | Promise<unknown>;
  clientEvents?: ClientEventPublisherPort | null | undefined;
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  ownerTaskId?: string | null | undefined;
  /** 发起者分支（§10.4 第六轮）：完成通知路由给发起工具调用的线程。 */
  initiatorThreadKey?: string | null | undefined;
  initiatorChildAgentId?: string | null | undefined;
  kind?: string | null | undefined;
  resultType?: string | null | undefined;
  cancel?: (() => void) | null | undefined;
}

/** Background execution surface exposed to plugins. */
export interface BackgroundTaskPort {
  spawnBash(input: SpawnBashInput): BackgroundTask;
  runCallable(input: RunCallableInput): BackgroundTask;
}

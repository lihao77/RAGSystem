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
  kind?: string | null | undefined;
  resultType?: string | null | undefined;
  cancel?: (() => void) | null | undefined;
}

/** Background execution surface exposed to plugins. */
export interface BackgroundTaskPort {
  spawnBash(input: SpawnBashInput): BackgroundTask;
  runCallable(input: RunCallableInput): BackgroundTask;
}

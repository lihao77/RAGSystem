import type {
  AgentExecuteResult,
  AgentRunStartResult,
  CollaborateRequest,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "./execution.js";
import type { RollbackRetryInput } from "../../services/agent/execution/launchers.js";

export interface ExecutionStartOptions {
  followupPolicy?: "queue" | "reject";
}

/** Deployment-neutral execution write boundary for HTTP and realtime transports. */
export interface ExecutionApplication {
  startStream(request: StreamExecuteRequest, requestId: string, options?: ExecutionStartOptions): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  collaborateSequentially(request: CollaborateRequest, requestId: string): Promise<{
    results: AgentExecuteResult[];
    session_id: string;
    total_tasks: number;
  }>;
  collaborate(request: CollaborateRequest, requestId: string): Promise<{
    results: AgentExecuteResult[];
    session_id: string;
    total_tasks: number;
  }>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  stopSession(sessionId: string): Promise<boolean>;
}

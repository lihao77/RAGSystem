import type {
  AgentExecuteResult,
  AgentRunStartResult,
  CollaborateRequest,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "./execution.js";
import type { RollbackRetryInput } from "../../services/agent/execution/launchers.js";
import type { ResumeRunInput, ResumeRunResult } from "../../services/agent/execution/resume-executor.js";

/** Deployment-neutral execution write boundary for HTTP and realtime transports. */
export interface ExecutionApplication {
  startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  collaborateSequentially(request: CollaborateRequest, requestId: string): Promise<{
    results: AgentExecuteResult[];
    session_id: string;
    total_tasks: number;
  }>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  stopSession(sessionId: string): Promise<boolean>;
  resumeRun(input: ResumeRunInput): ResumeRunResult;
}

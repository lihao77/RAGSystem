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
  /**
   * 提前确认回调：消息通过基础校验（命令判定/空任务/运行冲突）后、进入耗时处理
   * （附件解析/插件变换/落库/启动）前恰好触发一次。realtime 通道据此立即回
   * phase=received 的 ACK——ACK 耗时与插件变换解耦；其后失败以 error 帧补偿。
   * 未传则保持原语义（启动完成后一次性返回结果）。
   */
  onAccepted?: (notice: ExecutionAcceptedNotice) => void;
}

export interface ExecutionAcceptedNotice {
  /** command：斜杠命令（执行结果经 command_result 消息返回）；缺省为 agent run。 */
  kind?: "command";
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

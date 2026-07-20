import type { ExecutionApplication } from "../../../../contracts/execution/execution-application.js";
import type { AgentExecutionServiceApi } from "../../../../services/agent/execution/index.js";

/** Adapter over the shared execution core assembled for the current tenant runtime. */
export class LocalExecutionApplication implements ExecutionApplication {
  constructor(
    private readonly execution: Pick<AgentExecutionServiceApi,
      "startStream" | "executeSynchronously" | "collaborateSequentially" | "startRollbackRetry" | "stopSession">,
  ) {}

  startStream(request: Parameters<AgentExecutionServiceApi["startStream"]>[0], requestId: string) {
    return this.execution.startStream(request, requestId);
  }
  executeSynchronously(request: Parameters<AgentExecutionServiceApi["executeSynchronously"]>[0], requestId: string) {
    return this.execution.executeSynchronously(request, requestId);
  }
  collaborateSequentially(request: Parameters<AgentExecutionServiceApi["collaborateSequentially"]>[0], requestId: string) {
    return this.execution.collaborateSequentially(request, requestId);
  }
  startRollbackRetry(input: Parameters<AgentExecutionServiceApi["startRollbackRetry"]>[0]) {
    return this.execution.startRollbackRetry(input);
  }
  stopSession(sessionId: string) { return this.execution.stopSession(sessionId); }
}

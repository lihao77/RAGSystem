import type { ExecutionApplication } from "../../../contracts/execution/execution-application.js";
import type { AgentExecutionServiceApi } from "./index.js";

/** Deployment-neutral request adapter over a tenant runtime's execution core. */
export class RuntimeExecutionApplication implements ExecutionApplication {
  constructor(
    private readonly execution: Pick<AgentExecutionServiceApi,
      "startStream" | "executeSynchronously" | "collaborateSequentially" | "collaborate" | "startRollbackRetry" | "stopSession">,
  ) {}

  startStream(
    request: Parameters<AgentExecutionServiceApi["startStream"]>[0],
    requestId: string,
    options?: Parameters<AgentExecutionServiceApi["startStream"]>[2],
  ) { return this.execution.startStream(request, requestId, options); }
  executeSynchronously(request: Parameters<AgentExecutionServiceApi["executeSynchronously"]>[0], requestId: string) { return this.execution.executeSynchronously(request, requestId); }
  collaborateSequentially(request: Parameters<AgentExecutionServiceApi["collaborateSequentially"]>[0], requestId: string) { return this.execution.collaborateSequentially(request, requestId); }
  collaborate(request: Parameters<AgentExecutionServiceApi["collaborate"]>[0], requestId: string) { return this.execution.collaborate(request, requestId); }
  startRollbackRetry(input: Parameters<AgentExecutionServiceApi["startRollbackRetry"]>[0]) { return this.execution.startRollbackRetry(input); }
  stopSession(sessionId: string) { return this.execution.stopSession(sessionId); }
}

import type {
  AgentInvocationChildInput,
  AgentInvocationHandle,
  AgentInvocationOutcome,
  AgentInvocationPort,
  AgentInvocationRequest,
  AgentInvocationRootInput,
} from "../../../contracts/execution/agent-invocation.js";
import type { ExecutionStartDisposition } from "../../../contracts/execution/execution-storage.js";
import type { AgentRunEngine } from "./run-engine.js";

/**
 * Single adapter for root and child Agent invocations.
 *
 * Root invocations retain the durable session-start semantics of startRun;
 * child invocations retain executeRun's independent lease and lineage fields.
 * The orchestration layer now depends on this contract instead of RunEngine.
 */
export class AgentInvocationService implements AgentInvocationPort {
  constructor(private readonly runEngine: AgentRunEngine) {}

  invoke(input: AgentInvocationRequest): AgentInvocationHandle {
    return input.scope === "root"
      ? this.invokeRoot(input)
      : this.invokeChild(input);
  }

  private invokeRoot(input: AgentInvocationRootInput): AgentInvocationHandle {
    const { scope: _scope, mode, execution: _execution, ...runInput } = input;
    const handle = this.runEngine.startRun({
      ...runInput,
      resume: mode === "resume",
    });
    return {
      started: handle.started,
      session_id: handle.session_id,
      run_id: handle.run_id ?? "",
      task_id: handle.task_id ?? "",
      request_id: handle.request_id ?? "",
      kind: "agent_run",
      durableStarted: handle.durableStarted,
      promise: handle.promise.then((outcome) => normalizeOutcome(outcome, handle.run_id ?? "")),
    };
  }

  private invokeChild(input: AgentInvocationChildInput): AgentInvocationHandle {
    const abortController = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        abortController.abort();
      } else {
        input.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }
    }
    let durableSettled = false;
    let resolveDurable: (disposition: ExecutionStartDisposition) => void = () => undefined;
    let rejectDurable: (error: unknown) => void = () => undefined;
    const durableStarted = new Promise<ExecutionStartDisposition>((resolve, reject) => {
      resolveDurable = resolve;
      rejectDurable = reject;
    });
    // Background child callers await `promise` but do not normally await this
    // secondary durability signal. Keep a handler attached while preserving the
    // original rejection for callers that explicitly await `durableStarted`.
    void durableStarted.catch(() => undefined);
    const onStartDisposition = (disposition: ExecutionStartDisposition): void => {
      input.onStartDisposition?.(disposition);
      if (durableSettled) return;
      durableSettled = true;
      resolveDurable(disposition);
    };
    const {
      scope: _scope,
      mode: _mode,
      execution: _execution,
      signal: _signal,
      onStartDisposition: _inputStart,
      ...runInput
    } = input;
    const promise = this.runEngine.executeRun({
      ...runInput,
      abortController,
      onStartDisposition,
    }).then((outcome) => normalizeOutcome(outcome, input.runId)).catch((error) => {
      if (!durableSettled) {
        durableSettled = true;
        rejectDurable(error);
      }
      throw error;
    });
    return {
      started: true,
      session_id: input.sessionId,
      run_id: input.runId,
      task_id: input.taskId,
      request_id: input.requestId,
      kind: "agent_run",
      promise,
      durableStarted,
    };
  }
}

function normalizeOutcome(
  outcome: Awaited<ReturnType<AgentRunEngine["executeRun"]>> | Awaited<ReturnType<AgentRunEngine["startRun"]>["promise"]>,
  runId: string,
): AgentInvocationOutcome {
  const outcomeRunId = "runId" in outcome && typeof outcome.runId === "string"
    ? outcome.runId
    : runId;
  return {
    content: outcome.content,
    success: outcome.success,
    runId: outcomeRunId,
    ...(("contentParts" in outcome && Array.isArray(outcome.contentParts)) ? { contentParts: outcome.contentParts } : {}),
    ...(outcome.suspended ? { suspended: true } : {}),
    ...(("interactionKind" in outcome && outcome.interactionKind) ? { interactionKind: outcome.interactionKind } : {}),
    ...(("followup" in outcome && outcome.followup) ? { followup: outcome.followup } : {}),
    ...(("followupJoined" in outcome && outcome.followupJoined) ? { followupJoined: true } : {}),
    ...(("followupFailed" in outcome && outcome.followupFailed) ? { followupFailed: true } : {}),
  };
}

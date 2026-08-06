import { describe, expect, it } from "vitest";
import {
  AgentKernel,
  RecoverableInterrupt,
  RuntimeAbortError,
  createHookRegistry,
  type HookInputMap,
  type Protocol,
  type RuntimeSession,
} from "@ragsystem/agent-sdk";

describe("run.finally hook", () => {
  it("reports completed runs", async () => {
    const statuses: HookInputMap["run.finally"]["status"][] = [];
    const hooks = createHookRegistry();
    hooks.on("run.finally", ({ status }) => { statuses.push(status); });

    const result = await createKernel(hooks).run(createSession());

    expect(result.content).toBe("done");
    expect(statuses).toEqual(["completed"]);
  });

  it.each([
    ["failed", new Error("provider failed")],
    ["aborted", new RuntimeAbortError()],
    ["suspended", new RecoverableInterrupt({
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-1",
      kind: "approval",
    })],
  ] as const)("reports %s runs", async (expectedStatus, error) => {
    const statuses: HookInputMap["run.finally"]["status"][] = [];
    const hooks = createHookRegistry();
    hooks.on("run.finally", ({ status }) => { statuses.push(status); });

    await expect(createKernel(hooks, error).run(createSession())).rejects.toBe(error);

    expect(statuses).toEqual([expectedStatus]);
  });
});

function createKernel(
  hooks: ReturnType<typeof createHookRegistry>,
  invokeError?: Error,
): AgentKernel {
  const protocol = {
    buildRequest: () => ({ messages: [] }),
    invoke: async () => {
      if (invokeError) throw invokeError;
      return {
        kind: "final",
        finalAnswer: "done",
        assistantMessage: { role: "assistant", content: "done" },
        finishReason: "stop",
      };
    },
    renderObservations: () => [],
    toModelMessages: (messages: unknown) => messages,
  } as unknown as Protocol;
  return new AgentKernel({
    context: { buildMessages: () => [] },
    protocol,
    tools: { executeRound: async () => [] },
    events: { emit: () => undefined },
    refresher: { refresh: async () => [] },
    hooks,
  });
}

function createSession(): RuntimeSession {
  return {
    profile: { agentName: "agent" },
    provider: { key: null, provider_type: "test" },
    modelName: "model",
    conversation: [],
    sessionId: "session-1",
    runId: "run-1",
    taskId: null,
    requestId: "request-1",
    rootCallId: "root-call",
    threadKey: "root",
    parentCallId: null,
    startRound: 0,
    resumeToolResults: new Map(),
  } as unknown as RuntimeSession;
}

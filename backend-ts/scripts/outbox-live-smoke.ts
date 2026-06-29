import { randomUUID } from "node:crypto";

interface Options {
  baseUrl: string;
  sessionId: string;
  scenarios: SmokeScenario[];
  task: string;
  interruptTask: string;
  backgroundTask: string;
  approvalTask: string;
  userInputTask: string;
  delegationTask: string;
  selectedLlm: string | null;
  timeoutMs: number;
  replayTimeoutMs: number;
}

type SmokeScenario = "basic" | "interrupt" | "background" | "approval" | "user_input" | "delegation";

interface PermissionPolicy {
  mode?: string;
  auto_accept_patterns?: unknown[];
  audit_all_checks?: boolean;
  approval_timeout?: number;
  skip_all_approvals?: boolean;
}

interface WebSocketLike {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(event: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(event: "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(event: "error", listener: (event: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
}

interface WebSocketConstructorLike {
  new(url: string): WebSocketLike;
}

interface Collector {
  url: string;
  events: Record<string, unknown>[];
  errors: string[];
  waitForOpen(timeoutMs: number): Promise<boolean>;
  waitForEvent(
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null>;
  close(): void;
}

const DEFAULT_TASK = "Reply exactly: outbox-live-smoke-ok";
const DEFAULT_INTERRUPT_TASK =
  "Write a long, detailed migration analysis of at least 2000 words. Continue until stopped.";
const DEFAULT_BACKGROUND_TASK = [
  "You must call execute_bash exactly once.",
  "Use command 'echo outbox-bg-ok'.",
  "Set run_in_background to true, timeout to 30, and description to 'outbox background smoke'.",
  "After the tool starts, reply with a concise final answer.",
].join(" ");
const DEFAULT_APPROVAL_TASK = [
  "You must call execute_bash exactly once.",
  "Use command 'touch outbox-approval-smoke.txt'.",
  "Set run_in_background to false, timeout to 30, and description to 'outbox approval smoke'.",
  "After the tool completes, reply with a concise final answer.",
].join(" ");
const DEFAULT_USER_INPUT_TASK = [
  "You must call request_user_input exactly once.",
  "Ask the user this prompt: 'What scope should the smoke test use?'",
  "Use text input.",
  "After the user responds, include the provided value in a concise final answer.",
].join(" ");
const DEFAULT_DELEGATION_TASK = [
  "You must call call_agent exactly once.",
  "Use agent_name 'general_agent'.",
  "Use task 'Reply exactly: outbox-child-ok'.",
  "Use context_hint 'No tools are needed; answer directly.'.",
  "After the child agent returns, reply with a concise final answer.",
].join(" ");
const DEFAULT_SCENARIOS: SmokeScenario[] = ["basic", "interrupt"];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const wsConstructor = getWebSocketConstructor();
  if (!wsConstructor) {
    throw new Error("global WebSocket is not available; run with Node 24+");
  }

  await assertHealthy(options);
  await assertOutboxLive(options);
  await assertRuntimeReady(options);

  const results: Array<{ scenario: SmokeScenario; sessionId: string; runId: string; maxEventSeq: number }> = [];
  for (const scenario of options.scenarios) {
    if (scenario === "basic") {
      results.push(await runBasicScenario(options, wsConstructor));
      continue;
    }
    if (scenario === "interrupt") {
      results.push(await runInterruptScenario(options, wsConstructor));
      continue;
    }
    if (scenario === "background") {
      results.push(await runBackgroundScenario(options, wsConstructor));
      continue;
    }
    if (scenario === "approval") {
      results.push(await runApprovalScenario(options, wsConstructor));
      continue;
    }
    if (scenario === "user_input") {
      results.push(await runUserInputScenario(options, wsConstructor));
      continue;
    }
    if (scenario === "delegation") {
      results.push(await runDelegationScenario(options, wsConstructor));
      continue;
    }
  }

  console.log("Outbox live smoke passed");
  for (const result of results) {
    console.log(
      `  ${result.scenario}: session_id=${result.sessionId} run_id=${result.runId} max_event_seq=${result.maxEventSeq}`,
    );
  }
}

async function runDelegationScenario(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
): Promise<{ scenario: "delegation"; sessionId: string; runId: string; maxEventSeq: number }> {
  const sessionId = `${options.sessionId}-delegation`;
  const live = createCollector(options, wsConstructor, null, sessionId);
  try {
    await assertOpen(live, 5000, "delegation live WebSocket");
    const runId = await startAgentStream(options, sessionId, options.delegationTask);
    const start = await live.waitForEvent(
      (event) => event.type === "call.agent.start" && extractRunId(event) === runId,
      options.timeoutMs,
    );
    if (!start) {
      throw new Error(
        `timed out waiting for call.agent.start; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const end = await live.waitForEvent(
      (event) => event.type === "call.agent.end" && extractRunId(event) === runId,
      options.timeoutMs,
    );
    if (!end) {
      throw new Error(
        `timed out waiting for call.agent.end; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId),
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for delegation run terminal event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const maxEventSeq = await verifyLiveAndReplay(options, wsConstructor, sessionId, live.events);
    return { scenario: "delegation", sessionId, runId, maxEventSeq };
  } finally {
    live.close();
  }
}

async function runUserInputScenario(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
): Promise<{ scenario: "user_input"; sessionId: string; runId: string; maxEventSeq: number }> {
  const sessionId = `${options.sessionId}-user-input`;
  const live = createCollector(options, wsConstructor, null, sessionId);
  try {
    await assertOpen(live, 5000, "user_input live WebSocket");
    const runId = await startAgentStream(options, sessionId, options.userInputTask);
    const inputEvent = await live.waitForEvent(
      (event) => isUserInputRequiredEvent(event) && extractRunId(event) === runId,
      options.timeoutMs,
    );
    if (!inputEvent) {
      throw new Error(
        `timed out waiting for user input event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const inputId = extractUserInputId(inputEvent);
    if (!inputId) {
      throw new Error(`user input event is missing input_id: ${JSON.stringify(inputEvent)}`);
    }
    await requestJson(
      options,
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(inputId)}/respond`,
      {
        method: "POST",
        body: { kind: "user_input", value: "outbox" },
      },
    );
    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId),
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for user_input run terminal event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const maxEventSeq = await verifyLiveAndReplay(options, wsConstructor, sessionId, live.events);
    return { scenario: "user_input", sessionId, runId, maxEventSeq };
  } finally {
    live.close();
  }
}

async function runApprovalScenario(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
): Promise<{ scenario: "approval"; sessionId: string; runId: string; maxEventSeq: number }> {
  const sessionId = `${options.sessionId}-approval`;
  const originalPolicy = await getPermissionPolicy(options);
  const live = createCollector(options, wsConstructor, null, sessionId);
  try {
    await setPermissionPolicy(options, {
      ...(originalPolicy ?? {}),
      mode: "standard",
      auto_accept_patterns: [],
      skip_all_approvals: false,
    });
    await assertOpen(live, 5000, "approval live WebSocket");
    const runId = await startAgentStream(options, sessionId, options.approvalTask);
    const approvalEvent = await live.waitForEvent(
      (event) => isApprovalRequiredEvent(event) && extractRunId(event) === runId,
      options.timeoutMs,
    );
    if (!approvalEvent) {
      throw new Error(
        `timed out waiting for approval event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const approvalId = extractApprovalId(approvalEvent);
    if (!approvalId) {
      throw new Error(`approval event is missing approval_id: ${JSON.stringify(approvalEvent)}`);
    }
    await requestJson(
      options,
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(approvalId)}/respond`,
      {
        method: "POST",
        body: { kind: "approval", approved: true, message: "approved by outbox live smoke" },
      },
    );
    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId),
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for approval run terminal event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const maxEventSeq = await verifyLiveAndReplay(options, wsConstructor, sessionId, live.events);
    return { scenario: "approval", sessionId, runId, maxEventSeq };
  } finally {
    live.close();
    if (originalPolicy) {
      await setPermissionPolicy(options, originalPolicy);
    }
  }
}

async function runBackgroundScenario(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
): Promise<{ scenario: "background"; sessionId: string; runId: string; maxEventSeq: number }> {
  const sessionId = `${options.sessionId}-background`;
  const originalPolicy = await getPermissionPolicy(options);
  const live = createCollector(options, wsConstructor, null, sessionId);
  try {
    await setPermissionPolicy(options, {
      ...(originalPolicy ?? {}),
      mode: "dangerously_skip_permissions",
      skip_all_approvals: true,
    });
    await assertOpen(live, 5000, "background live WebSocket");
    const runId = await startAgentStream(options, sessionId, options.backgroundTask);
    const completed = await live.waitForEvent(
      (event) => event.type === "background.task.completed" && extractRunId(event) === runId,
      options.timeoutMs,
    );
    if (!completed) {
      throw new Error(
        `timed out waiting for background.task.completed; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId),
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for background run terminal event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const maxEventSeq = await verifyLiveAndReplay(options, wsConstructor, sessionId, live.events);
    return { scenario: "background", sessionId, runId, maxEventSeq };
  } finally {
    live.close();
    if (originalPolicy) {
      await setPermissionPolicy(options, originalPolicy);
    }
  }
}

async function runBasicScenario(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
): Promise<{ scenario: "basic"; sessionId: string; runId: string; maxEventSeq: number }> {
  const sessionId = `${options.sessionId}-basic`;
  const live = createCollector(options, wsConstructor, null, sessionId);
  try {
    await assertOpen(live, 5000, "live WebSocket");
    const runId = await startAgentStream(options, sessionId, options.task);
    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId),
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for run terminal event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const maxEventSeq = await verifyLiveAndReplay(options, wsConstructor, sessionId, live.events);
    return { scenario: "basic", sessionId, runId, maxEventSeq };
  } finally {
    live.close();
  }
}

async function runInterruptScenario(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
): Promise<{ scenario: "interrupt"; sessionId: string; runId: string; maxEventSeq: number }> {
  const sessionId = `${options.sessionId}-interrupt`;
  const live = createCollector(options, wsConstructor, null, sessionId);
  try {
    await assertOpen(live, 5000, "interrupt live WebSocket");
    const runId = await startAgentStream(options, sessionId, options.interruptTask);
    const started = await live.waitForEvent(
      (event) => extractRunId(event) === runId && event.type === "session.run_started",
      Math.min(options.timeoutMs, 10000),
    );
    if (!started) {
      throw new Error(`timed out waiting for interrupt run start; run_id=${runId}`);
    }
    await requestJson(options, "/api/agent/stream/stop", {
      method: "POST",
      body: { session_id: sessionId },
    });
    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId) && getRunEndStatus(event) === "interrupted",
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for interrupted run.end; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }
    const maxEventSeq = await verifyLiveAndReplay(options, wsConstructor, sessionId, live.events);
    return { scenario: "interrupt", sessionId, runId, maxEventSeq };
  } finally {
    live.close();
  }
}

async function startAgentStream(options: Options, sessionId: string, task: string): Promise<string> {
  const start = await requestJson(options, "/api/agent/stream", {
    method: "POST",
    headers: { "x-request-id": `outbox-live-smoke-${randomUUID()}` },
    body: {
      task,
      session_id: sessionId,
      attachments: [],
      ...(options.selectedLlm ? { selected_llm: options.selectedLlm } : {}),
    },
  });
  const startData = asRecord(asRecord(start).data);
  if (startData.started !== true) {
    throw new Error(`stream did not start: ${JSON.stringify(startData)}`);
  }
  const runId = asString(startData.run_id);
  if (!runId) {
    throw new Error(`stream start response is missing run_id: ${JSON.stringify(startData)}`);
  }
  return runId;
}

async function verifyLiveAndReplay(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
  sessionId: string,
  liveEvents: Record<string, unknown>[],
): Promise<number> {
  const durableEvents = liveEvents.filter((event) => getEventSeq(event) !== null);
  assertStrictlyIncreasingEventSeq(durableEvents);
  assertStreamSeqStartsAtOne(liveEvents);
  const maxEventSeq = Math.max(...durableEvents.map((event) => getEventSeq(event) ?? 0));
  if (!Number.isSafeInteger(maxEventSeq) || maxEventSeq <= 0) {
    throw new Error("live WebSocket did not receive durable event_seq values");
  }

  const replayAfterSeq = Math.max(0, maxEventSeq - 1);
  const replay = createCollector(options, wsConstructor, replayAfterSeq, sessionId);
  try {
    await assertOpen(replay, 5000, "replay WebSocket");
    const replayStart = await replay.waitForEvent(
      (event) => event.type === "reconnect_start" && event.replay_source === "durable_outbox",
      options.replayTimeoutMs,
    );
    if (!replayStart) {
      throw new Error(`durable replay did not start from after_seq=${replayAfterSeq}`);
    }
    const replayed = await replay.waitForEvent(
      (event) => {
        const eventSeq = getEventSeq(event);
        return eventSeq !== null && eventSeq > replayAfterSeq;
      },
      options.replayTimeoutMs,
    );
    if (!replayed) {
      throw new Error(`durable replay did not emit an event after event_seq=${replayAfterSeq}`);
    }
    const replayEnd = await replay.waitForEvent(
      (event) => event.type === "reconnect_end" && event.replay_source === "durable_outbox",
      options.replayTimeoutMs,
    );
    if (!replayEnd) {
      throw new Error("durable replay did not emit reconnect_end");
    }
    assertStreamSeqStartsAtOne(replay.events);
    return maxEventSeq;
  } finally {
    replay.close();
  }
}

async function assertHealthy(options: Options): Promise<void> {
  const response = await requestJson(options, "/api/health");
  const data = asRecord(asRecord(response).data);
  if (data.status !== "healthy") {
    throw new Error(`backend health check failed: ${JSON.stringify(response)}`);
  }
}

async function assertOutboxLive(options: Options): Promise<void> {
  const response = await requestJson(options, "/api/agent/metrics");
  const mode = asString(getPath(response, ["data", "event_outbox", "delivery_mode"]));
  if (mode !== "outbox_live") {
    throw new Error(`expected event_outbox.delivery_mode=outbox_live, got ${mode ?? "missing"}`);
  }
}

async function assertRuntimeReady(options: Options): Promise<void> {
  const query = options.selectedLlm ? `?selected_llm=${encodeURIComponent(options.selectedLlm)}` : "";
  const response = await requestJson(options, `/api/agent/runtime-core/status${query}`);
  const data = asRecord(asRecord(response).data);
  if (data.can_execute !== true) {
    throw new Error(`runtime-core is not executable: ${JSON.stringify(data.requirements ?? data)}`);
  }
}

async function getPermissionPolicy(options: Options): Promise<PermissionPolicy | null> {
  const response = await requestJson(options, "/api/permissions/policy");
  return isRecord(response) ? response as PermissionPolicy : null;
}

async function setPermissionPolicy(options: Options, policy: PermissionPolicy): Promise<void> {
  await requestJson(options, "/api/permissions/policy", {
    method: "PUT",
    body: policy as Record<string, unknown>,
  });
}

async function requestJson(
  options: Options,
  path: string,
  requestOptions: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<unknown> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: requestOptions.method ?? "GET",
    headers: {
      ...(requestOptions.body ? { "content-type": "application/json" } : {}),
      ...(requestOptions.headers ?? {}),
    },
    ...(requestOptions.body ? { body: JSON.stringify(requestOptions.body) } : {}),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Keep the original text in the error below.
  }
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

function createCollector(
  options: Options,
  wsConstructor: WebSocketConstructorLike,
  afterEventSeq: number | null,
  sessionId: string,
): Collector {
  const events: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const eventWaiters: Array<{
    predicate: (event: Record<string, unknown>) => boolean;
    resolve: (event: Record<string, unknown> | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  const openWaiters: Array<(value: boolean) => void> = [];
  let opened = false;
  let closed = false;
  const url = toWebSocketUrl(options, sessionId, afterEventSeq);
  const ws = new wsConstructor(url);

  const settleOpen = (value: boolean): void => {
    if (opened || closed) {
      return;
    }
    opened = value;
    while (openWaiters.length) {
      openWaiters.shift()?.(value);
    }
  };

  ws.addEventListener("open", () => settleOpen(true), { once: true });
  ws.addEventListener("close", () => {
    closed = true;
    if (!opened) {
      while (openWaiters.length) {
        openWaiters.shift()?.(false);
      }
    }
  }, { once: true });
  ws.addEventListener("error", (event) => {
    errors.push(`websocket error: ${stringifyReference(event)}`);
  });
  ws.addEventListener("message", (event) => {
    void decodeWebSocketData(event.data)
      .then((raw) => {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
          errors.push(`non-object websocket payload: ${raw.slice(0, 120)}`);
          return;
        }
        events.push(parsed);
        notifyEventWaiters(eventWaiters, parsed);
      })
      .catch((error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      });
  });

  return {
    url,
    events,
    errors,
    waitForOpen: (timeoutMs) => {
      if (opened) {
        return Promise.resolve(true);
      }
      if (closed) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        let timeout: ReturnType<typeof setTimeout>;
        const waiter = (value: boolean): void => {
          clearTimeout(timeout);
          resolve(value);
        };
        timeout = setTimeout(() => {
          const index = openWaiters.indexOf(waiter);
          if (index >= 0) {
            openWaiters.splice(index, 1);
          }
          resolve(false);
        }, timeoutMs);
        openWaiters.push(waiter);
      });
    },
    waitForEvent: (predicate, timeoutMs) => {
      const existing = events.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Record<string, unknown> | null>((resolve) => {
        const waiter = {
          predicate,
          resolve,
          timeout: setTimeout(() => {
            const index = eventWaiters.indexOf(waiter);
            if (index >= 0) {
              eventWaiters.splice(index, 1);
            }
            resolve(null);
          }, timeoutMs),
        };
        eventWaiters.push(waiter);
      });
    },
    close: () => {
      for (const waiter of eventWaiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.resolve(null);
      }
      try {
        ws.close();
      } catch {
        // ignored: the smoke is already done with the socket.
      }
    },
  };
}

function notifyEventWaiters(
  waiters: Array<{
    predicate: (event: Record<string, unknown>) => boolean;
    resolve: (event: Record<string, unknown> | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>,
  event: Record<string, unknown>,
): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (!waiter?.predicate(event)) {
      continue;
    }
    waiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(event);
  }
}

async function assertOpen(collector: Collector, timeoutMs: number, label: string): Promise<void> {
  const opened = await collector.waitForOpen(timeoutMs);
  if (!opened) {
    throw new Error(`${label} did not open; errors=[${collector.errors.join("; ")}] url=${collector.url}`);
  }
}

function assertStrictlyIncreasingEventSeq(events: Record<string, unknown>[]): void {
  if (events.length === 0) {
    throw new Error("no durable event_seq values observed");
  }
  let previous = 0;
  for (const event of events) {
    const eventSeq = getEventSeq(event);
    if (eventSeq === null) {
      continue;
    }
    if (eventSeq <= previous) {
      throw new Error(`non-monotonic event_seq: previous=${previous} current=${eventSeq}`);
    }
    previous = eventSeq;
  }
}

function assertStreamSeqStartsAtOne(events: Record<string, unknown>[]): void {
  const seqs = events
    .map((event) => asNumber(event.stream_seq))
    .filter((seq): seq is number => seq !== null);
  if (seqs.length === 0) {
    throw new Error("no stream_seq values observed");
  }
  if (seqs[0] !== 1) {
    throw new Error(`stream_seq did not start at 1: [${seqs.join(", ")}]`);
  }
  for (let index = 1; index < seqs.length; index += 1) {
    if (seqs[index] !== seqs[index - 1]! + 1) {
      throw new Error(`non-contiguous stream_seq: [${seqs.join(", ")}]`);
    }
  }
}

function isRunTerminalEvent(event: Record<string, unknown>, runId: string): boolean {
  if (event.type !== "run.end" && event.type !== "done") {
    return false;
  }
  const eventRunId = extractRunId(event);
  return !eventRunId || eventRunId === runId;
}

function extractRunId(event: Record<string, unknown>): string | null {
  return asString(event.run_id) ?? asString(getPath(event, ["data", "run_id"]));
}

function getRunEndStatus(event: Record<string, unknown>): string | null {
  return asString(getPath(event, ["data", "status"])) ?? asString(event.status);
}

function isApprovalRequiredEvent(event: Record<string, unknown>): boolean {
  if (event.type === "user.approval_required") {
    return true;
  }
  if (event.type !== "interaction.required") {
    return false;
  }
  const kind = asString(getPath(event, ["data", "kind"])) ?? asString(event.kind);
  return kind === "approval";
}

function extractApprovalId(event: Record<string, unknown>): string | null {
  return (
    asString(event.approval_id) ??
    asString(event.interaction_id) ??
    asString(getPath(event, ["data", "approval_id"])) ??
    asString(getPath(event, ["data", "interaction_id"])) ??
    asString(getPath(event, ["content", "approval_id"])) ??
    asString(getPath(event, ["content", "interaction_id"]))
  );
}

function isUserInputRequiredEvent(event: Record<string, unknown>): boolean {
  if (event.type === "user.input_required") {
    return true;
  }
  if (event.type !== "interaction.required") {
    return false;
  }
  const kind = asString(getPath(event, ["data", "kind"])) ?? asString(event.kind);
  return kind === "user_input";
}

function extractUserInputId(event: Record<string, unknown>): string | null {
  return (
    asString(event.input_id) ??
    asString(event.interaction_id) ??
    asString(getPath(event, ["data", "input_id"])) ??
    asString(getPath(event, ["data", "interaction_id"])) ??
    asString(getPath(event, ["content", "input_id"])) ??
    asString(getPath(event, ["content", "interaction_id"]))
  );
}

function getEventSeq(event: Record<string, unknown>): number | null {
  return asNumber(event.event_seq);
}

function summarizeEventTypes(events: Record<string, unknown>[]): string[] {
  return Array.from(new Set(events.map((event) => asString(event.type) ?? "unknown")));
}

function toWebSocketUrl(options: Options, sessionId: string, afterEventSeq: number | null): string {
  const url = new URL(`/api/agent/sessions/${encodeURIComponent(sessionId)}/ws`, options.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (afterEventSeq !== null) {
    url.searchParams.set("after_seq", String(afterEventSeq));
  }
  return url.toString();
}

async function decodeWebSocketData(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (isRecord(data) && typeof data.text === "function") {
    return String(await (data.text as () => Promise<string>)());
  }
  return String(data);
}

function getWebSocketConstructor(): WebSocketConstructorLike | null {
  const ctor = (globalThis as unknown as { WebSocket?: WebSocketConstructorLike }).WebSocket;
  return typeof ctor === "function" ? ctor : null;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    baseUrl: process.env.OUTBOX_SMOKE_URL ?? "http://127.0.0.1:5002",
    sessionId: process.env.OUTBOX_SMOKE_SESSION_ID ?? `outbox-live-smoke-${Date.now()}`,
    scenarios: parseScenarios(process.env.OUTBOX_SMOKE_SCENARIOS),
    task: process.env.OUTBOX_SMOKE_TASK ?? DEFAULT_TASK,
    interruptTask: process.env.OUTBOX_SMOKE_INTERRUPT_TASK ?? DEFAULT_INTERRUPT_TASK,
    backgroundTask: process.env.OUTBOX_SMOKE_BACKGROUND_TASK ?? DEFAULT_BACKGROUND_TASK,
    approvalTask: process.env.OUTBOX_SMOKE_APPROVAL_TASK ?? DEFAULT_APPROVAL_TASK,
    userInputTask: process.env.OUTBOX_SMOKE_USER_INPUT_TASK ?? DEFAULT_USER_INPUT_TASK,
    delegationTask: process.env.OUTBOX_SMOKE_DELEGATION_TASK ?? DEFAULT_DELEGATION_TASK,
    selectedLlm: normalizeString(process.env.OUTBOX_SMOKE_SELECTED_LLM),
    timeoutMs: Number.parseInt(process.env.OUTBOX_SMOKE_TIMEOUT_MS ?? "120000", 10),
    replayTimeoutMs: Number.parseInt(process.env.OUTBOX_SMOKE_REPLAY_TIMEOUT_MS ?? "5000", 10),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--base-url") {
      options.baseUrl = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--task") {
      options.task = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--interrupt-task") {
      options.interruptTask = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--background-task") {
      options.backgroundTask = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--approval-task") {
      options.approvalTask = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--user-input-task") {
      options.userInputTask = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--delegation-task") {
      options.delegationTask = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--scenarios") {
      options.scenarios = parseScenarios(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--selected-llm") {
      options.selectedLlm = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--replay-timeout-ms") {
      options.replayTimeoutMs = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  options.timeoutMs = parsePositiveInt(String(options.timeoutMs), "--timeout-ms");
  options.replayTimeoutMs = parsePositiveInt(String(options.replayTimeoutMs), "--replay-timeout-ms");
  if (!options.sessionId.trim()) {
    throw new Error("--session-id must not be empty");
  }
  if (options.scenarios.length === 0) {
    throw new Error("--scenarios must include at least one scenario");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run smoke:outbox-live -- [options]

Verifies TS backend outbox_live WebSocket delivery and durable replay cursor behavior.

Options:
  --base-url <url>            TS backend URL. Default: OUTBOX_SMOKE_URL or http://127.0.0.1:5002
  --session-id <id>           Session id. Default: OUTBOX_SMOKE_SESSION_ID or generated id
  --scenarios <list>          Comma-separated scenarios: basic,interrupt,background,approval,user_input,delegation. Default: basic,interrupt
  --task <text>               Agent task. Default: OUTBOX_SMOKE_TASK or "${DEFAULT_TASK}"
  --interrupt-task <text>     Long-running task used for interrupt scenario.
  --background-task <text>    Tool-use task used for background scenario.
  --approval-task <text>      Tool-use task used for approval scenario.
  --user-input-task <text>    Tool-use task used for user_input scenario.
  --delegation-task <text>    Tool-use task used for delegation scenario.
  --selected-llm <value>      Optional frontend selected_llm override.
  --timeout-ms <n>            Run completion timeout. Default: 120000
  --replay-timeout-ms <n>     Durable replay wait timeout. Default: 5000`);
}

function parseScenarios(raw: string | undefined): SmokeScenario[] {
  if (!raw?.trim()) {
    return [...DEFAULT_SCENARIOS];
  }
  const scenarios: SmokeScenario[] = [];
  for (const item of raw.split(",")) {
    const scenario = item.trim();
    if (!scenario) {
      continue;
    }
    if (
      scenario !== "basic" &&
      scenario !== "interrupt" &&
      scenario !== "background" &&
      scenario !== "approval" &&
      scenario !== "user_input" &&
      scenario !== "delegation"
    ) {
      throw new Error(`Unknown smoke scenario: ${scenario}`);
    }
    if (!scenarios.includes(scenario)) {
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(raw: string, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringifyReference(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

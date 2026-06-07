import { randomUUID } from "node:crypto";

interface Options {
  baseUrl: string;
  sessionId: string;
  task: string;
  selectedLlm: string | null;
  timeoutMs: number;
  replayTimeoutMs: number;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const wsConstructor = getWebSocketConstructor();
  if (!wsConstructor) {
    throw new Error("global WebSocket is not available; run with Node 24+");
  }

  await assertHealthy(options);
  await assertOutboxLive(options);
  await assertRuntimeReady(options);

  const live = createCollector(options, wsConstructor, null);
  try {
    await assertOpen(live, 5000, "live WebSocket");
    const start = await requestJson(options, "/api/agent/stream", {
      method: "POST",
      headers: { "x-request-id": `outbox-live-smoke-${randomUUID()}` },
      body: {
        task: options.task,
        session_id: options.sessionId,
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

    const terminal = await live.waitForEvent(
      (event) => isRunTerminalEvent(event, runId),
      options.timeoutMs,
    );
    if (!terminal) {
      throw new Error(
        `timed out waiting for run terminal event; observed types=[${summarizeEventTypes(live.events).join(", ")}]`,
      );
    }

    const durableEvents = live.events.filter((event) => getEventSeq(event) !== null);
    assertStrictlyIncreasingEventSeq(durableEvents);
    assertStreamSeqStartsAtOne(live.events);
    const maxEventSeq = Math.max(...durableEvents.map((event) => getEventSeq(event) ?? 0));
    if (!Number.isSafeInteger(maxEventSeq) || maxEventSeq <= 0) {
      throw new Error("live WebSocket did not receive durable event_seq values");
    }

    const replayAfterSeq = Math.max(0, maxEventSeq - 1);
    const replay = createCollector(options, wsConstructor, replayAfterSeq);
    try {
      await assertOpen(replay, 5000, "replay WebSocket");
      const replayStart = await replay.waitForEvent(
        (event) => event.type === "reconnect_start" && event.replay_source === "durable_outbox",
        options.replayTimeoutMs,
      );
      if (!replayStart) {
        throw new Error(`durable replay did not start from after_event_seq=${replayAfterSeq}`);
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

      console.log("Outbox live smoke passed");
      console.log(`  base_url=${options.baseUrl}`);
      console.log(`  session_id=${options.sessionId}`);
      console.log(`  run_id=${runId}`);
      console.log(`  live_events=${live.events.length}`);
      console.log(`  max_event_seq=${maxEventSeq}`);
      console.log(`  replay_url=${replay.url}`);
      console.log(`  replayed_event_seq=${getEventSeq(replayed)}`);
    } finally {
      replay.close();
    }
  } finally {
    live.close();
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
  const url = toWebSocketUrl(options, afterEventSeq);
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
  const eventRunId = asString(event.run_id) ?? asString(getPath(event, ["data", "run_id"]));
  return !eventRunId || eventRunId === runId;
}

function getEventSeq(event: Record<string, unknown>): number | null {
  return asNumber(event.event_seq);
}

function summarizeEventTypes(events: Record<string, unknown>[]): string[] {
  return Array.from(new Set(events.map((event) => asString(event.type) ?? "unknown")));
}

function toWebSocketUrl(options: Options, afterEventSeq: number | null): string {
  const url = new URL(`/api/agent/sessions/${encodeURIComponent(options.sessionId)}/ws`, options.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (afterEventSeq !== null) {
    url.searchParams.set("after_event_seq", String(afterEventSeq));
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
    task: process.env.OUTBOX_SMOKE_TASK ?? DEFAULT_TASK,
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
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run smoke:outbox-live -- [options]

Verifies TS backend outbox_live WebSocket delivery and durable replay cursor behavior.

Options:
  --base-url <url>            TS backend URL. Default: OUTBOX_SMOKE_URL or http://127.0.0.1:5002
  --session-id <id>           Session id. Default: OUTBOX_SMOKE_SESSION_ID or generated id
  --task <text>               Agent task. Default: OUTBOX_SMOKE_TASK or "${DEFAULT_TASK}"
  --selected-llm <value>      Optional frontend selected_llm override.
  --timeout-ms <n>            Run completion timeout. Default: 120000
  --replay-timeout-ms <n>     Durable replay wait timeout. Default: 5000`);
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

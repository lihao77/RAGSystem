import { RagChatHttpError } from "./errors.js";

export interface AguiEvent {
  type: string;
  threadId?: string;
  runId?: string;
  eventSeq?: number;
  [key: string]: unknown;
}

export interface AguiMessageInput {
  id?: string;
  role: "user" | "assistant" | "system" | "tool" | "developer";
  content?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface AguiResumeInput {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export interface AguiRunInput {
  threadId: string;
  runId?: string;
  state?: Record<string, unknown>;
  messages?: AguiMessageInput[];
  tools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    riskLevel?: "low" | "medium" | "high";
    readOnly?: boolean;
  }>;
  context?: unknown[];
  forwardedProps?: Record<string, unknown>;
  resume?: AguiResumeInput[];
  reconnect?: { runId: string; afterSeq?: number };
  attachments?: Array<{ file_id: string }>;
  selectedLlm?: string;
  /** 请求级思考档位(off/low/medium/high);缺省 = 跟随 provider 配置。 */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "on";
}

export interface AguiRunHandle {
  started: Promise<AguiEvent>;
  completed: Promise<AguiEvent | null>;
  abort(reason?: string): void;
}

export interface AguiSseClientOptions {
  endpoint: string;
  fetch: typeof fetch;
  resolveHeaders: () => Promise<Record<string, string>>;
  onEvent?: (event: AguiEvent) => void;
}

/**
 * Minimal AG-UI POST/SSE client used as the WebSocket fallback.
 * The stream stays alive after RUN_STARTED; callers can observe completion
 * while the session facade projects each event as it arrives.
 */
export class AguiSseClient {
  constructor(private readonly options: AguiSseClientOptions) {}

  start(input: AguiRunInput, signal?: AbortSignal): AguiRunHandle {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }

    let started = false;
    let finished = false;
    let resolveStarted!: (event: AguiEvent) => void;
    let rejectStarted!: (error: Error) => void;
    let resolveCompleted!: (event: AguiEvent | null) => void;
    let rejectCompleted!: (error: Error) => void;
    const startedPromise = new Promise<AguiEvent>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const completedPromise = new Promise<AguiEvent | null>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    const finish = (event: AguiEvent | null) => {
      if (finished) return;
      finished = true;
      if (!started) {
        rejectStarted(new Error(event?.type === "RUN_ERROR" && typeof event.message === "string"
          ? event.message
          : "AG-UI run 未启动"));
      }
      resolveCompleted(event);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    };
    const receive = (event: AguiEvent) => {
      try {
        this.options.onEvent?.(event);
      } catch (error) {
        if (typeof globalThis.reportError === "function") globalThis.reportError(error);
        else console.error("AG-UI event listener failed", error);
      }
      if (event.type === "RUN_STARTED" && !started) {
        started = true;
        resolveStarted(event);
      }
      if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") finish(event);
    };

    void this.consume(input, controller.signal, receive)
      .then(() => {
        if (finished) return;
        const error = started ? new Error("AG-UI SSE 在终态事件前结束") : new Error("AG-UI run 未启动");
        if (!started) rejectStarted(error);
        rejectCompleted(error);
        if (signal) signal.removeEventListener("abort", abortFromCaller);
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!started) rejectStarted(normalized);
        rejectCompleted(normalized);
        if (signal) signal.removeEventListener("abort", abortFromCaller);
      });

    return {
      started: startedPromise,
      completed: completedPromise,
      abort: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason);
      },
    };
  }

  private async consume(
    input: AguiRunInput,
    signal: AbortSignal,
    receive: (event: AguiEvent) => void,
  ): Promise<void> {
    const headers = await this.options.resolveHeaders();
    const response = await this.options.fetch(this.options.endpoint, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      const details = await readResponseBody(response);
      throw new RagChatHttpError(response.status, errorMessage(details, `AG-UI 请求失败 (HTTP ${response.status})`), details);
    }
    if (!response.body) throw new Error("AG-UI 响应缺少 SSE body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const parsed = takeSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) receive(event);
      if (chunk.done) break;
    }
    const tail = takeSseEvents(`${buffer}\n\n`);
    for (const event of tail.events) receive(event);
  }
}

function takeSseEvents(input: string): { events: AguiEvent[]; rest: string } {
  const blocks = input.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  const events: AguiEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const value: unknown = JSON.parse(data);
      if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string") {
        events.push(value as AguiEvent);
      }
    } catch {
      // Ignore comments, keep-alives, and malformed SSE blocks.
    }
  }
  return { events, rest };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
  }
  return fallback;
}

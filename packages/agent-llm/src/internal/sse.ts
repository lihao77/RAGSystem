import { ExternalCallTimeoutError } from "../external-call-policy.js";

export interface ServerSentEvent {
  event: string;
  data: string;
}

/** Incremental SSE decoder supporting CRLF, multiline data, comments and a final unterminated event. */
export class SseDecoder {
  private buffer = "";

  push(text: string, flush = false): ServerSentEvent[] {
    this.buffer += text;
    const frames = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = flush ? "" : (frames.pop() ?? "");
    if (flush && this.buffer) frames.push(this.buffer);
    return frames.map(parseFrame).filter((event): event is ServerSentEvent => event !== null);
  }
}

function parseFrame(frame: string): ServerSentEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

export async function readSse(
  response: Response,
  idleTimeoutMs: number,
  consume: (event: ServerSentEvent) => Promise<boolean | void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("LLM streaming response did not include a readable body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  let stopped = false;
  let aborted = false;
  const abortReader = (): void => {
    aborted = true;
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", abortReader, { once: true });
  if (signal?.aborted) abortReader();
  try {
    while (!stopped) {
      const chunk = await readChunk(reader, idleTimeoutMs);
      if (chunk.done) break;
      for (const event of sse.push(decoder.decode(chunk.value, { stream: true }))) {
        if (await consume(event)) {
          stopped = true;
          break;
        }
      }
    }
    if (!stopped) {
      for (const event of sse.push(decoder.decode(), true)) {
        if (await consume(event)) break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    if (stopped || aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  const timeout = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ExternalCallTimeoutError(timeout));
          void reader.cancel().catch(() => undefined);
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * LLM fetch mock——SDK 自建 OpenAiCompatibleClient 后，测试拦截 global fetch 伪造厂商响应。
 *
 * 仅 openai_compatible（/chat/completions 流式 SSE）形态：测试 provider 均为 deepseek/openai_compatible，
 * SDK 走 stream 路径（OpenAiCompatibleClient.stream）。这些 mock 不触达 SDK 协议解析（SDK 用真实 client），
 * 只让 run 跑通以观察 backend 行为；断言在 backend 集成层。
 *
 * 捕获 requests[].body（解析后的 JSON）供"LLM 请求历史是否含 X"类断言使用。
 */
import { vi } from "vitest";

export type LlmMockMode = "ok" | "abort" | "fail";

export interface CapturedLlmRequest {
  url: string;
  body: { messages?: unknown[]; model?: string; [key: string]: unknown } | undefined;
}

export interface LlmMock {
  /** 捕获的请求（按调用顺序）；body 为解析后的 JSON，供断言 messages/model。 */
  readonly requests: CapturedLlmRequest[];
  /** 阻塞下一次（及期间）的响应直到 release；用于保持 run 在"运行中"状态。 */
  hold(): void;
  release(): void;
  /** 还原 global fetch（等价 vi.unstubAllGlobals）。 */
  restore(): void;
}

/** 对齐真实 fetch 在 signal abort 时的 reject——isAbortError 据 name==="AbortError" 识别。 */
function makeAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** 伪造 openai_compatible /chat/completions 的流式 SSE 响应（单段 content + finish stop + [DONE]）。 */
function makeOpenAiChatStreamResponse(content: string): Response {
  const encoder = new TextEncoder();
  const frames: string[] = [];
  if (content) {
    frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * 拦截 global fetch 伪造 LLM 响应。
 * - contents：按调用顺序消费的响应内容（超出序号后复用最后一条；空数组返回空 content）。
 * - mode：ok（正常 SSE）/ abort（监听 signal，abort 时 reject AbortError）/ fail（reject Error）。
 */
export function mockLlm(options: { contents?: string[]; mode?: LlmMockMode } = {}): LlmMock {
  const contents = options.contents ?? [];
  const mode: LlmMockMode = options.mode ?? "ok";
  const requests: CapturedLlmRequest[] = [];
  let index = 0;
  let gate: { promise: Promise<void>; resolve: () => void } | null = null;

  const handle: LlmMock = {
    requests,
    hold() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { promise, resolve };
    },
    release() {
      const g = gate;
      gate = null;
      g?.resolve();
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      let body: CapturedLlmRequest["body"];
      try {
        body = init?.body ? JSON.parse(init.body as string) : undefined;
      } catch {
        body = undefined;
      }
      requests.push({ url, body });

      if (mode === "fail") {
        return Promise.reject(new Error("run-failed"));
      }
      if (mode === "abort") {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            reject(makeAbortError());
            return;
          }
          signal?.addEventListener("abort", () => reject(makeAbortError()), { once: true });
        });
      }
      const content = contents[index] ?? contents[contents.length - 1] ?? "";
      if (index < contents.length) {
        index += 1;
      }
      const response = makeOpenAiChatStreamResponse(content);
      return gate ? gate.promise.then(() => response) : Promise.resolve(response);
    }),
  );

  return handle;
}

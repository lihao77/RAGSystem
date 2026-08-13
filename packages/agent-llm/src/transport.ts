import { randomUUID } from "node:crypto";
import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { LlmRequest, LlmStreamHandler, ProviderConfig } from "./types.js";
import { DEFAULT_ENDPOINTS } from "./provider-registry.js";
import {
  DEFAULT_PROVIDER_TIMEOUT_SECONDS,
  externalCallPolicy,
  ExternalCallTimeoutError,
  isRetryableExternalError,
  isRetryableHttpStatus,
  providerCallPolicy,
  RetryableHttpError,
} from "./external-call-policy.js";
import { isRecord } from "./internal/records.js";

export type EndpointKind = "chat" | "responses" | "anthropic";

export function resolveEndpoint(provider: ProviderConfig, kind: EndpointKind): string {
  const configured = String(provider.api_endpoint ?? DEFAULT_ENDPOINTS[provider.provider_type] ?? "").trim();
  if (!configured) throw new Error(`Provider '${provider.name}' is missing api_endpoint`);
  const base = configured.replace(/\/+$/, "");
  if (kind === "chat") return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  if (kind === "responses") return base.endsWith("/responses") ? base : `${base}/responses`;
  return base.endsWith("/messages") ? base : `${base}/v1/messages`;
}

export function requireApiKey(provider: ProviderConfig): string {
  const apiKey = String(provider.api_key ?? "").trim();
  if (!apiKey) throw new Error("Provider API key is required");
  return apiKey;
}

export function bearerHeaders(apiKey: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

export function requestInit(request: LlmRequest, headers: Record<string, string>, body: unknown): RequestInit {
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
  if (request.signal) init.signal = request.signal;
  return init;
}

export async function executeProviderCall<T>(
  request: LlmRequest,
  endpoint: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const key = circuitKey(request);
  const policy = providerCallPolicy(request.provider);
  const attemptIds = new Map<number, { id: string; startedAt: number }>();
  return externalCallPolicy.execute({
    key,
    ...policy,
    operationTimeoutMs: null,
    ...(request.signal ? { signal: request.signal } : {}),
    onAttemptStarted: ({ attempt, maxAttempts }) => {
      const attemptId = randomUUID();
      attemptIds.set(attempt, { id: attemptId, startedAt: Date.now() });
      request.onAttemptLifecycle?.({ phase: "started", attemptId, attempt, maxAttempts });
    },
    onAttemptFailed: ({ attempt, maxAttempts, error, willRetry, delayMs }) => {
      const current = attemptIds.get(attempt) ?? { id: randomUUID(), startedAt: Date.now() };
      request.onAttemptLifecycle?.({
        phase: "failed",
        attemptId: current.id,
        attempt,
        maxAttempts,
        willRetry,
        ...(delayMs !== undefined ? { retryDelayMs: delayMs } : {}),
        elapsedMs: Math.max(0, Date.now() - current.startedAt),
        error: errorMessage(error),
      });
    },
    onAttemptCompleted: ({ attempt, maxAttempts }) => {
      const current = attemptIds.get(attempt) ?? { id: randomUUID(), startedAt: Date.now() };
      request.onAttemptLifecycle?.({
        phase: "completed",
        attemptId: current.id,
        attempt,
        maxAttempts,
        elapsedMs: Math.max(0, Date.now() - current.startedAt),
      });
    },
    operation: async ({ attempt, signal }) => {
      void attempt;
      const response = await fetchProviderResponse(
        request.provider,
        endpoint,
        init,
        signal,
        policy.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_SECONDS * 1000,
      );
      if (isRetryableHttpStatus(response.status)) {
        const body = await readJson(response, policy.timeoutMs);
        throw new RetryableHttpError(response.status, extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
      }
      return consume(response);
    },
  });
}

async function fetchProviderResponse(
  provider: ProviderConfig,
  endpoint: string,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const timeout = Math.max(1, timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ExternalCallTimeoutError(timeout));
  }, timeout);
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  try {
    return provider.transport?.type === "ipc_socket"
      ? await fetchOverIpcSocket(provider, endpoint, { ...init, signal })
      : await fetch(endpoint, { ...init, signal });
  } catch (error) {
    if (timedOut) throw new ExternalCallTimeoutError(timeout);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOverIpcSocket(
  provider: ProviderConfig,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const transport = provider.transport;
  if (!transport || transport.type !== "ipc_socket") {
    throw new Error(`Provider '${provider.name}' is missing IPC socket transport configuration`);
  }
  const envName = transport.socket_env.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`Provider '${provider.name}' has an invalid IPC socket environment variable`);
  }
  const socketPath = process.env[envName]?.trim();
  if (!socketPath) {
    throw new Error(`Provider '${provider.name}' IPC socket environment variable '${envName}' is not configured`);
  }
  const target = new URL(endpoint);
  if (target.protocol !== "http:") {
    throw new Error(`Provider '${provider.name}' IPC socket endpoint must use the http: scheme`);
  }

  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = requestHttp({
      socketPath,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? "GET",
      headers: { host: target.host, ...headers },
      ...(init.signal ? { signal: init.signal } : {}),
    }, (response) => {
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders(response.headers),
      }));
    });
    request.once("error", reject);
    if (init.body === undefined || init.body === null) {
      request.end();
      return;
    }
    if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.end(init.body);
      return;
    }
    request.destroy(new Error(`Provider '${provider.name}' IPC socket transport only supports buffered request bodies`));
  });
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

export async function consumeProviderStream<T>(
  onChunk: LlmStreamHandler,
  read: (guardedOnChunk: LlmStreamHandler) => Promise<T>,
): Promise<T> {
  let outputStarted = false;
  try {
    return await read(async (chunk) => {
      if (chunk.content || (chunk.toolCalls?.length ?? 0) > 0) outputStarted = true;
      return onChunk(chunk);
    });
  } catch (error) {
    if (outputStarted && isRetryableExternalError(error)) {
      throw new Error(`LLM stream interrupted after output started: ${errorMessage(error)}`, { cause: error });
    }
    throw error;
  }
}

export function providerTimeoutMs(request: LlmRequest): number {
  return providerCallPolicy(request.provider).timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_SECONDS * 1000;
}

export async function requireOkJson(response: Response, request: LlmRequest): Promise<Record<string, unknown>> {
  const body = await raceAbort(readJson(response, providerTimeoutMs(request)), request.signal, response);
  if (!response.ok) throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
  return body;
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, response: Response): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // `read` is evaluated by the caller before entering raceAbort. Attach the
    // same settlement observers as the normal branch before returning the
    // abort error so a late body-read rejection is not left unhandled.
    void operation.then(undefined, () => undefined);
    void response.body?.cancel().catch(() => undefined);
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      void response.body?.cancel().catch(() => undefined);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export async function readJson(response: Response, timeoutMs?: number): Promise<Record<string, unknown>> {
  const text = await readText(response, timeoutMs);
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

export function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return typeof body.message === "string" ? body.message : null;
}

function circuitKey(request: LlmRequest): string {
  const provider = request.provider;
  return `provider:${provider.key ?? provider.name ?? provider.provider_type}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown provider error");
}

async function readText(response: Response, timeoutMs?: number): Promise<string> {
  if (timeoutMs === undefined) return response.text();
  const timeout = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ExternalCallTimeoutError(timeout));
          void response.body?.cancel().catch(() => undefined);
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

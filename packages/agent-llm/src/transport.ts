import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { LlmRequest, ProviderConfig } from "./types.js";
import { DEFAULT_ENDPOINTS } from "./provider-registry.js";
import {
  externalCallPolicy,
  ExternalCallTimeoutError,
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

export async function fetchProvider(
  request: LlmRequest,
  endpoint: string,
  init: RequestInit,
  deferSuccess = false,
): Promise<Response> {
  return externalCallPolicy.execute({
    key: circuitKey(request),
    ...providerCallPolicy(request.provider),
    ...(request.signal ? { signal: request.signal } : {}),
    deferSuccess,
    operation: async ({ signal }) => {
      const requestInit = { ...init, signal };
      const response = request.provider.transport?.type === "ipc_socket"
        ? await fetchOverIpcSocket(request.provider, endpoint, requestInit)
        : await fetch(endpoint, requestInit);
      if (isRetryableHttpStatus(response.status)) {
        const body = await readJson(response);
        throw new RetryableHttpError(response.status, extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
      }
      return response;
    },
  });
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

export async function readProviderStream<T>(request: LlmRequest, read: () => Promise<T>): Promise<T> {
  const key = circuitKey(request);
  const policy = providerCallPolicy(request.provider);
  try {
    const result = await read();
    externalCallPolicy.recordSuccess(key, policy);
    return result;
  } catch (error) {
    if (request.signal?.aborted) externalCallPolicy.recordAbort(key);
    else externalCallPolicy.recordFailure(key, error, policy);
    throw error;
  }
}

export function recordStreamFailure(request: LlmRequest, error: unknown): void {
  externalCallPolicy.recordFailure(circuitKey(request), error, providerCallPolicy(request.provider));
}

export function providerTimeoutMs(request: LlmRequest): number {
  return providerCallPolicy(request.provider).timeoutMs ?? 60_000;
}

export async function requireOkJson(response: Response, request: LlmRequest): Promise<Record<string, unknown>> {
  const body = await readJson(response, providerTimeoutMs(request));
  if (!response.ok) throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
  return body;
}

export async function readJson(response: Response, timeoutMs?: number): Promise<Record<string, unknown>> {
  const text = await readText(response, timeoutMs).catch((error: unknown) => {
    if (error instanceof ExternalCallTimeoutError) throw error;
    return "";
  });
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

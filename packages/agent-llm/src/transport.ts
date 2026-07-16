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
      const response = await fetch(endpoint, { ...init, signal });
      if (isRetryableHttpStatus(response.status)) {
        const body = await readJson(response);
        throw new RetryableHttpError(response.status, extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
      }
      return response;
    },
  });
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

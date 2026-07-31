import type { AuthSession } from "@ragsystem/api-contracts";

import { RagChatError, RagChatHttpError } from "./errors.js";
import type { RagChatLoginOptions } from "./types.js";

export async function loginRagSystem(options: RagChatLoginOptions): Promise<AuthSession> {
  if (!options.username || !options.password) {
    throw new RagChatError("username 和 password 不能为空", { code: "USER_CREDENTIALS_REQUIRED" });
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RagChatError("当前环境不支持 fetch", { code: "FETCH_UNAVAILABLE" });
  }
  const url = options.endpoint ?? `${trimBaseUrl(options.baseUrl)}/api/auth/login`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify({ username: options.username, password: options.password }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new RagChatHttpError(response.status, errorMessage(body, `登录失败 (HTTP ${response.status})`), body);
  }
  if (!isRecord(body) || typeof body.token !== "string" || !body.token) {
    throw new RagChatError("登录响应缺少 token", { code: "INVALID_LOGIN_RESPONSE", details: body });
  }
  return body as unknown as AuthSession;
}

function trimBaseUrl(baseUrl = ""): string {
  return String(baseUrl).replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  for (const key of ["message", "detail", "error"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

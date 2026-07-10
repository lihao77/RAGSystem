import { z } from "zod";

const INVALID_SESSION_ID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const MAX_SESSION_ID_LENGTH = 200;

export function isSafeSessionId(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= MAX_SESSION_ID_LENGTH
    && normalized !== "."
    && normalized !== ".."
    && !INVALID_SESSION_ID_CHARS.test(normalized);
}

export function assertSafeSessionId(value: string): void {
  if (!isSafeSessionId(value)) throw new Error("session_id 包含非法路径字符或长度超限");
}

export const OptionalSessionIdSchema = z.string().refine((value) => !value.trim() || isSafeSessionId(value), {
  message: "session_id 包含非法路径字符或长度超限",
});

export const RequiredSessionIdSchema = z.string().refine(isSafeSessionId, {
  message: "session_id 包含非法路径字符或长度超限",
});

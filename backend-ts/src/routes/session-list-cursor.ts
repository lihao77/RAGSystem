import { z } from "zod";

import type { SessionListCursor } from "../contracts/session/session.js";
import { HttpError } from "../utils/errors.js";

const CursorPayloadSchema = z.object({
  activity_at: z.string().datetime({ offset: true }),
  session_id: z.string().min(1),
}).strict();

export function encodeSessionListCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify({
    activity_at: cursor.activityAt,
    session_id: cursor.sessionId,
  }), "utf8").toString("base64url");
}

export function decodeSessionListCursor(value: string | undefined): SessionListCursor | null {
  if (value === undefined || value === "") return null;
  try {
    const parsed = CursorPayloadSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    const canonical = encodeSessionListCursor({ activityAt: parsed.activity_at, sessionId: parsed.session_id });
    if (canonical !== value) throw new Error("non-canonical cursor");
    return { activityAt: parsed.activity_at, sessionId: parsed.session_id };
  } catch {
    throw new HttpError(400, "invalid_request", "会话列表 cursor 无效");
  }
}

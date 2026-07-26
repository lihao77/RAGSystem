import { describe, expect, it } from "vitest";

import { decodeSessionListCursor, encodeSessionListCursor } from "../../src/routes/session-list-cursor.js";

describe("session list cursor", () => {
  it("round trips a stable activity/session cursor", () => {
    const cursor = { activityAt: "2026-07-26T10:20:30.000Z", sessionId: "session-a" };
    expect(decodeSessionListCursor(encodeSessionListCursor(cursor))).toEqual(cursor);
  });

  it.each(["not-base64", Buffer.from("{}", "utf8").toString("base64url"), "="])(
    "rejects malformed cursor %s",
    (cursor) => expect(() => decodeSessionListCursor(cursor)).toThrow("cursor 无效"),
  );
});

import { describe, expect, it } from "vitest";

import {
  CreateSessionResponseSchema,
  SessionDetailResponseSchema,
  SessionListResponseSchema,
  SessionMessageListResponseSchema,
  SessionMessageRunStepsResponseSchema,
  SessionPermissionResponseSchema,
} from "../src/session.js";

const detail = {
  session_id: "session-1",
  tenant_id: "tnt_local",
  user_id: "usr_local",
  permission_mode: null,
  metadata: { workspace_root: "D:/work" },
  created_at: "2026-07-16 10:00:00",
  updated_at: "2026-07-16 10:00:00",
};

describe("Session REST contracts", () => {
  it("accepts the create response without requiring persisted timestamps", () => {
    expect(CreateSessionResponseSchema.parse({
      success: true,
      message: "created",
      data: {
        session_id: detail.session_id,
        user_id: detail.user_id,
        permission_mode: detail.permission_mode,
        metadata: detail.metadata,
      },
    }).data.session_id).toBe("session-1");
  });

  it("keeps detail and list DTOs explicit", () => {
    expect(SessionDetailResponseSchema.parse({ success: true, message: "ok", data: detail }).data).toEqual(detail);
    expect(SessionListResponseSchema.parse({
      success: true,
      message: "ok",
      data: {
        items: [{
          ...detail,
          title: "Session",
          last_message: "hello",
          last_message_at: detail.updated_at,
          first_message: "hello",
          unread_count: 0,
        }],
        total: 1,
        limit: 20,
        offset: 0,
        has_more: false,
      },
    }).data.total).toBe(1);
  });

  it("rejects storage-only fields and invalid permission modes", () => {
    expect(() => SessionDetailResponseSchema.parse({
      success: true,
      message: "ok",
      data: { ...detail, internal_rowid: 1 },
    })).toThrow();
    expect(() => SessionPermissionResponseSchema.parse({
      success: true,
      message: "ok",
      data: { mode: "admin" },
    })).toThrow();
  });

  it("models message pages and reuses the downlink wire protocol for execution history", () => {
    const message = {
      id: "message-1",
      seq: 1,
      session_id: detail.session_id,
      role: "assistant",
      content: "done",
      metadata: { run_id: "run-1" },
      created_at: detail.created_at,
      thread_key: "root",
      child_agent_id: null,
      has_execution: true,
    };
    expect(SessionMessageListResponseSchema.parse({
      success: true,
      message: "ok",
      data: { items: [message], total: 1, limit: 20, offset: 0, has_more: false },
    }).data.items[0]?.id).toBe("message-1");

    expect(SessionMessageRunStepsResponseSchema.parse({
      success: true,
      message: "ok",
      data: {
        message_id: message.id,
        items: [{
          type: "stream_output",
          protocol_version: "1.0",
          session_id: detail.session_id,
          run_id: "run-1",
          payload: { phase: "final", content: "done" },
        }],
        total: 1,
        limit: 500,
        offset: 0,
        has_more: false,
      },
    }).data.items[0]?.type).toBe("stream_output");
  });
});

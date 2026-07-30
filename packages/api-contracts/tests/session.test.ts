import { describe, expect, it } from "vitest";

import {
  CreateSessionResponseSchema,
  SessionDetailResponseSchema,
  SessionListFacetsResponseSchema,
  SessionListResponseSchema,
  SessionMessageListResponseSchema,
  SessionMessageRunStepsResponseSchema,
  SessionPermissionResponseSchema,
} from "../src/session.js";

const origin = { type: "direct" as const, id: null, display_name: "直接对话", channel: "web" as const };
const detail = {
  session_id: "session-1",
  tenant_id: "tnt_local",
  owner_user_id: "usr_local",
  visibility: "private" as const,
  origin,
  workspace: { workspace_id: "workspace-1", display_name: "ragsystem", root_path: "D:/work" },
  permission_mode: null,
  metadata: { title: "Session" },
  created_at: "2026-07-16 10:00:00",
  updated_at: "2026-07-16 10:00:00",
};

describe("Session REST contracts", () => {
  it("accepts explicit ownership, origin and workspace fields", () => {
    expect(CreateSessionResponseSchema.parse({
      success: true,
      message: "created",
      data: {
        session_id: detail.session_id,
        owner_user_id: detail.owner_user_id,
        visibility: detail.visibility,
        origin,
        workspace: detail.workspace,
        permission_mode: detail.permission_mode,
        metadata: detail.metadata,
      },
    }).data.session_id).toBe("session-1");
  });

  it("models the session list as a cursor page without storage fields", () => {
    expect(SessionDetailResponseSchema.parse({ success: true, message: "ok", data: detail }).data).toEqual(detail);
    const data = SessionListResponseSchema.parse({
      success: true,
      message: "ok",
      data: {
        items: [{
          session_id: detail.session_id,
          title: "Session",
          last_message: "hello",
          activity_at: detail.updated_at,
          first_message: "hello",
          unread_count: 0,
          origin,
          workspace: { workspace_id: "workspace-1", display_name: "ragsystem", root_path: "D:/work" },
        }],
        next_cursor: "opaque-cursor",
      },
    }).data;
    expect(data.next_cursor).toBe("opaque-cursor");
    expect(data.items[0]).not.toHaveProperty("metadata");
    expect(data.items[0]).not.toHaveProperty("updated_at");
  });

  it("models source and workspace facets", () => {
    const data = SessionListFacetsResponseSchema.parse({
      success: true,
      message: "ok",
      data: {
        type_counts: { direct: 1, bot: 2, widget: 3 },
        origins: [{ type: "bot", id: "bot-1", display_name: "售后助手", count: 2 }],
        workspaces: [{ workspace_id: "workspace-1", display_name: "ragsystem", root_path: "D:/work", count: 1 }],
      },
    }).data;
    expect(data.type_counts.widget).toBe(3);
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
      data: { items: [message], total: 1, limit: 20, offset: 0, has_more: false, outbox_watermark: 12 },
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

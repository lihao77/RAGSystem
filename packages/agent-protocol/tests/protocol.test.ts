import { describe, expect, it } from "vitest";

import {
  AttachmentRefSchema,
  AttachmentsExtensionSchema,
  ClientToServerEnvelopeSchema,
  ServerToClientEnvelopeSchema,
} from "../src/protocol.js";
import {
  EnvelopeDeliveryCursor,
  getEnvelopeCursorSeq,
} from "../src/envelope-delivery.js";

describe("agent-protocol envelope compatibility", () => {
  it("上行附件严格只接受 file_id", () => {
    expect(AttachmentRefSchema.parse({ file_id: "file-1" })).toEqual({ file_id: "file-1" });
    expect(() => AttachmentRefSchema.parse({
      file_id: "file-1",
      stored_path: "private/object-key",
    })).toThrow();
  });

  it("校验唯一的 attachments@v1 消息扩展", () => {
    expect(AttachmentsExtensionSchema.parse({
      kind: "attachments",
      version: 1,
      data: {
        items: [{
          file_id: "file-1",
          original_name: "hostMCP.png",
          stored_name: "file-1_hostMCP.png",
          mime: "image/png",
          size: 3,
          kind: "image",
        }],
      },
    })).toMatchObject({ kind: "attachments", version: 1 });
  });

  it("允许服务端权威附件快照声明受控绝对路径", () => {
    expect(AttachmentsExtensionSchema.parse({
      kind: "attachments",
      version: 1,
      data: {
        items: [{
          file_id: "file-nc",
          original_name: "ocean.nc",
          stored_name: "ocean.nc",
          mime: "application/x-netcdf",
          size: 1024,
          kind: "file",
          file_path: "D:\\data\\ocean.nc",
          file_path_space: "absolute",
        }],
      },
    })).toMatchObject({
      data: { items: [{ file_path_space: "absolute" }] },
    });
  });

  it("保留 typed envelope 的公共游标和路由字段", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "run_started",
      protocol_version: "1.0",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "call-1",
      seq: 42,
      message_id: "message-1",
      timestamp: 123,
      payload: {},
    });

    expect(parsed).toMatchObject({
      session_id: "session-1",
      run_id: "run-1",
      call_id: "call-1",
      seq: 42,
      message_id: "message-1",
      timestamp: 123,
    });
  });

  it("统一校验上行 task submit 的 ui_context 和默认字段", () => {
    const parsed = ClientToServerEnvelopeSchema.parse({
      type: "user_driven_change",
      session_id: "session-1",
      payload: {
        category: "task_submit",
        ui_context: { route: "/orders" },
      },
    });

    expect(parsed.payload).toMatchObject({ task: "", attachments: [], ui_context: { route: "/orders" } });
  });

  it("拒绝不属于上行方向的 run_started", () => {
    expect(() => ClientToServerEnvelopeSchema.parse({
      type: "run_started",
      session_id: "session-1",
      run_id: "run-1",
    })).toThrow();
  });

  it("拒绝不属于下行方向的 tools.register", () => {
    expect(() => ServerToClientEnvelopeSchema.parse({
      type: "tools.register",
      session_id: "session-1",
      payload: { tools: [] },
    })).toThrow();
  });

  it("下行接受 abort 通知但拒绝 interaction response", () => {
    expect(ServerToClientEnvelopeSchema.parse({
      type: "abort",
      session_id: "session-1",
      payload: { scope: "run" },
    }).type).toBe("abort");
    expect(() => ServerToClientEnvelopeSchema.parse({
      type: "interaction",
      session_id: "session-1",
      call_id: "call-1",
      payload: { kind: "approval", phase: "responded", approved: true },
    })).toThrow();
  });

  it("接受带 lineage 的子 agent stream_output", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "stream_output",
      session_id: "session-1",
      run_id: "child-run",
      call_id: "child-call",
      agent_id: "worker",
      payload: {
        phase: "delta",
        content: "child output",
        lineage: { parent_call_id: "root-call" },
      },
    });

    expect(parsed.payload).toMatchObject({
      content: "child output",
      lineage: { parent_call_id: "root-call" },
    });
  });

  it("保留 message_saved 的服务端 round_index", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "state_sync",
      session_id: "session-1",
      run_id: "run-1",
      payload: {
        category: "message_saved",
        ref: {
          message_id: "message-1",
          role: "user",
          round_index: 2,
        },
      },
    });

    expect(parsed.payload).toMatchObject({
      ref: { message_id: "message-1", round_index: 2 },
    });
  });

  it("保留 send ack 的 command 适配类型", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "ack",
      session_id: "session-1",
      payload: { category: "send", ok: true, kind: "command" },
    });

    expect(parsed.payload).toMatchObject({ category: "send", ok: true, kind: "command" });
  });
});

describe("Envelope delivery cursor", () => {
  it("deduplicates durable events and advances from heartbeat cursors", () => {
    const cursor = new EnvelopeDeliveryCursor();

    expect(cursor.accept({ type: "stream_output", seq: 4 })).toBe(true);
    expect(cursor.accept({ type: "stream_output", seq: 4 })).toBe(false);
    expect(cursor.accept({ type: "stream_output", seq: 3 })).toBe(false);
    expect(cursor.accept({ type: "heartbeat", payload: { last_seq: 8 } })).toBe(true);
    expect(cursor.lastSeq).toBe(8);
    expect(cursor.accept({ type: "run_ended", seq: 7 })).toBe(false);
    expect(cursor.accept({ type: "session.reconnect" })).toBe(true);
  });

  it("uses top-level seq before heartbeat last_seq", () => {
    expect(getEnvelopeCursorSeq({
      type: "heartbeat",
      seq: 5,
      payload: { last_seq: 9 },
    })).toBe(5);
  });
});

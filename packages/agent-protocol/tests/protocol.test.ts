import { describe, expect, it } from "vitest";

import {
  ClientToServerEnvelopeSchema,
  ServerToClientEnvelopeSchema,
} from "../src/protocol.js";

describe("agent-protocol envelope compatibility", () => {
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
});

import { describe, expect, it } from "vitest";

import {
  AttachmentRefSchema,
  ClientToServerEnvelopeSchema,
  MessageContentPartSchema,
  ServerToClientEnvelopeSchema,
  SessionRuntimePayloadSchema,
  sessionLoadStrategyRestoresActiveRun,
} from "../src/protocol.js";
import {
  EnvelopeDeliveryCursor,
  getEnvelopeCursorSeq,
} from "../src/envelope-delivery.js";
import {
  applyEnvelope,
  createExecutionTreeState,
  getExecutionTree,
} from "../src/execution-tree.js";

describe("agent-protocol envelope compatibility", () => {
  it("projects an interrupted agent as stopped instead of failed", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, ServerToClientEnvelopeSchema.parse({
      type: "agent_started",
      protocol_version: "1.0",
      session_id: "session-1",
      run_id: "child-run-1",
      call_id: "child-call-1",
      agent_id: "worker",
      payload: { phase: "start", task: "child task" },
    }));
    applyEnvelope(state, ServerToClientEnvelopeSchema.parse({
      type: "agent_ended",
      protocol_version: "1.0",
      session_id: "session-1",
      run_id: "child-run-1",
      call_id: "child-call-1",
      agent_id: "worker",
      payload: { phase: "end", success: false, status: "interrupted", result: "stopped" },
    }));

    expect(getExecutionTree(state).root).toMatchObject({ status: "interrupted", result: "stopped" });
  });

  it("上行附件严格只接受 file_id", () => {
    expect(AttachmentRefSchema.parse({ file_id: "file-1" })).toEqual({ file_id: "file-1" });
    expect(() => AttachmentRefSchema.parse({
      file_id: "file-1",
      stored_path: "private/object-key",
    })).toThrow();
  });

  it("校验 content_parts 中的服务端权威附件快照", () => {
    expect(MessageContentPartSchema.parse({
      type: "attachment_ref",
      file_id: "file-nc",
      original_name: "ocean.nc",
      stored_name: "ocean.nc",
      mime: "application/x-netcdf",
      size: 1024,
      kind: "file",
      presentation: "attachment",
      file_path: "D:\\data\\ocean.nc",
      file_path_space: "absolute",
    })).toMatchObject({ file_path_space: "absolute" });
  });

  it("校验 slash command 的原始视图与不可变 Agent 快照", () => {
    expect(MessageContentPartSchema.parse({
      type: "command_ref",
      invocation_id: "cmd-1",
      name: "review",
      args: "当前仓库",
      raw_text: "/review 当前仓库",
      resolution: {
        kind: "prompt",
        agent_text: "请审查当前仓库",
        snapshot_id: "sha256:abc",
      },
    })).toMatchObject({ type: "command_ref", resolution: { kind: "prompt" } });

    expect(MessageContentPartSchema.parse({
      type: "command_result",
      invocation_id: "cmd-1",
      name: "review",
      success: false,
      text: "执行失败",
      error: "failed",
    })).toMatchObject({ type: "command_result", success: false });
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

  it("接受流式文件内容块和 final 权威快照", () => {
    const filePart = {
      type: "file_ref" as const,
      file_path: "results/map.png",
      presentation: "inline" as const,
      caption: "Risk map",
    };
    const added = ServerToClientEnvelopeSchema.parse({
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
      payload: { phase: "part_added", part_index: 1, part: filePart },
    });
    const final = ServerToClientEnvelopeSchema.parse({
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
      payload: {
        phase: "final",
        content: "Risk map",
        content_parts: [{ type: "text", text: "Risk map" }, filePart],
      },
    });

    expect(added.payload).toMatchObject({ phase: "part_added", part_index: 1, part: filePart });
    expect(final.payload).toMatchObject({ content_parts: [{ type: "text" }, filePart] });
  });

  it("接受 tool_result 的通用文件列表", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "tool_result",
      session_id: "session-1",
      call_id: "tool-1",
      payload: {
        tool: "execute_skill_script",
        phase: "end",
        ok: true,
        files: [{
          file_type: "image",
          path: "results/map.png",
          media_type: "image/png",
          size: 128,
          metadata: { lifecycle: "workspace" },
        }],
      },
    });

    expect(parsed.payload).toMatchObject({ files: [{ path: "results/map.png" }] });
  });

  it("接受后端权威的模型请求开始事件", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "model_request",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
      payload: { phase: "start", round: 2 },
    });

    expect(parsed.payload).toEqual({ phase: "start", round: 2 });
  });

  it("接受真实模型 attempt 失败与重试计划", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "model_attempt_failed",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
      payload: {
        phase: "failed",
        attempt_id: "attempt-1",
        attempt: 1,
        max_attempts: 3,
        round: 2,
        provider: "OpenAI",
        model: "gpt-test",
        will_retry: true,
        retry_delay_ms: 500,
        elapsed_ms: 120,
        error: "overloaded",
      },
    });

    expect(parsed.payload).toMatchObject({ attempt_id: "attempt-1", will_retry: true });
  });

  it("拒绝已删除的猜测式 retry state_sync", () => {
    expect(() => ServerToClientEnvelopeSchema.parse({
      type: "state_sync",
      session_id: "session-1",
      payload: { category: "retry", detail: {} },
    })).toThrow();
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
      payload: { category: "send", ok: true, kind: "command", request_id: "request-1" },
    });

    expect(parsed.payload).toMatchObject({
      category: "send",
      ok: true,
      kind: "command",
      request_id: "request-1",
    });
  });

  it("接受权威 runtime 指定 interaction 的恢复请求", () => {
    const parsed = ClientToServerEnvelopeSchema.parse({
      type: "resume",
      session_id: "session-1",
      call_id: "interaction-1",
      payload: { request_id: "resume-1" },
    });

    expect(parsed).toMatchObject({
      type: "resume",
      session_id: "session-1",
      call_id: "interaction-1",
      payload: { request_id: "resume-1" },
    });
  });

  it("接受 resume ack", () => {
    const parsed = ServerToClientEnvelopeSchema.parse({
      type: "ack",
      session_id: "session-1",
      payload: {
        category: "resume",
        ok: true,
        ref_call_id: "interaction-1",
        request_id: "resume-1",
      },
    });

    expect(parsed.payload).toMatchObject({
      category: "resume",
      ok: true,
      ref_call_id: "interaction-1",
      request_id: "resume-1",
    });
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

  it("can start from a history snapshot watermark", () => {
    const cursor = new EnvelopeDeliveryCursor();
    cursor.reset(12);

    expect(cursor.lastSeq).toBe(12);
    expect(cursor.accept({ type: "stream_output", seq: 12 })).toBe(false);
    expect(cursor.accept({ type: "stream_output", seq: 13 })).toBe(true);
  });
});

describe("Session runtime snapshot invariants", () => {
  const idle = {
    state: "idle" as const,
    load_strategy: "history" as const,
    allowed_actions: ["send_message" as const, "start_maintenance" as const],
    active_run: null,
    last_run: null,
    pending_interactions: [],
    resume_interaction_id: null,
    maintenance: null,
    observed_at: "2026-07-30T00:00:00.000Z",
  };
  const activeRun = {
    run_id: "run-1",
    status: "running" as const,
    execution_owner: "attached" as const,
    task: "task",
    request_id: "req-1",
    execution_kind: "agent_stream",
    started_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:01.000Z",
    activity: {
      models: [],
      tools: [],
      updated_at: "2026-07-30T00:00:01.000Z",
    },
  };

  it("accepts a canonical idle snapshot", () => {
    expect(SessionRuntimePayloadSchema.parse(idle)).toEqual(idle);
  });

  it.each([
    { ...idle, load_strategy: "attach_run" },
    { ...idle, active_run: activeRun },
    {
      ...idle,
      state: "waiting_interaction",
      load_strategy: "attach_run_and_present_interactions",
      active_run: { ...activeRun, status: "waiting_interaction" },
    },
    { ...idle, allowed_actions: ["resume_run"], resume_interaction_id: null },
    { ...idle, allowed_actions: ["send_message", "send_message"] },
    { ...idle, allowed_actions: [] },
    {
      ...idle,
      state: "running",
      load_strategy: "attach_run",
      active_run: activeRun,
      allowed_actions: [],
    },
  ])("rejects contradictory snapshot %#", (snapshot) => {
    expect(() => SessionRuntimePayloadSchema.parse(snapshot)).toThrow();
  });

  it("rejects resolved interactions because resumable resolutions use resume_interaction_id", () => {
    expect(() => SessionRuntimePayloadSchema.parse({
      ...idle,
      state: "suspended",
      load_strategy: "restore_suspended_run_and_present_interactions",
      active_run: { ...activeRun, status: "suspended", execution_owner: "detached" },
      allowed_actions: ["respond_interaction", "stop_run"],
      pending_interactions: [{
        interaction_id: "interaction-1",
        run_id: "run-1",
        root_run_id: "run-1",
        batch_id: "batch-1",
        kind: "approval",
        status: "resolved",
        requested_at: "2026-07-30T00:00:01.000Z",
        payload: { kind: "approval", phase: "required" },
      }],
    })).toThrow();
  });

  it("集中声明需要恢复 active run 执行树的加载策略", () => {
    expect(sessionLoadStrategyRestoresActiveRun("history")).toBe(false);
    expect(sessionLoadStrategyRestoresActiveRun("watch_maintenance")).toBe(false);
    expect(sessionLoadStrategyRestoresActiveRun("attach_run")).toBe(true);
    expect(sessionLoadStrategyRestoresActiveRun("attach_run_and_present_interactions")).toBe(true);
    expect(sessionLoadStrategyRestoresActiveRun("restore_suspended_run_and_present_interactions")).toBe(true);
    expect(sessionLoadStrategyRestoresActiveRun("attach_resume")).toBe(true);
  });
});

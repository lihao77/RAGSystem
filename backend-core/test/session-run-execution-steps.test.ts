import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRepositoryPort } from "../src/contracts/session/agent-session-repository.js";
import { AgentSessionApplication } from "../src/services/sessions/index.js";

function run(runId: string, overrides: Partial<{
  status: string;
  task_summary: string | null;
  thread_key: string;
  parent_run_id: string | null;
  child_agent_id: string | null;
  final_message_id: string | null;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    run_id: runId,
    status: "completed",
    task_summary: null,
    thread_key: "child:child-1",
    parent_run_id: null,
    child_agent_id: "child-1",
    final_message_id: `${runId}:final`,
    created_at: "2026-08-09T00:00:01.000Z",
    updated_at: "2026-08-09T00:00:02.000Z",
    ...overrides,
  };
}


describe("AgentSessionApplication participant Run steps", () => {
  it("exposes visible input boundaries but not the terminal assistant as execution carriers", async () => {
    const messages = [
      { id: "initial", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run", execution_kind: "agent_stream" } },
      { id: "followup-source", role: "user", metadata: { run_id: "root-run", source: "running_session" } },
      { id: "followup-kind", role: "user", metadata: { run_id: "root-run", execution_kind: "session_followup" } },
      { id: "agent-message", role: "user", metadata: { run_id: "root-run", agent_message: true } },
      { id: "assistant", role: "assistant", metadata: { run_id: "root-run" } },
    ];
    const repository = {
      listVisibleMessages: vi.fn(async () => ({
        items: messages,
        total: messages.length,
        limit: 20,
        offset: 0,
        has_more: false,
      })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listMessages({ sessionId: "session-1" });

    expect(result.items.map((item) => [item.id, item.has_execution])).toEqual([
      ["initial", true],
      ["followup-source", true],
      ["followup-kind", true],
      ["agent-message", true],
      ["assistant", false],
    ]);
  });

  it("lists every Run owned by the selected participant", async () => {
    const repository = {
      listParticipantRuns: vi.fn(async () => ({
        items: [
          run("child-run-1", { task_summary: "initial" }),
        ],
        total: 2,
      })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listParticipantRuns({
      sessionId: "session-1",
      participantId: "child-1",
      limit: 1,
      offset: 1,
    });

    expect(result).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });
    expect(result.items.map((item) => item.run_id)).toEqual(["child-run-1"]);
    expect(repository.listParticipantRuns).toHaveBeenCalledWith("session-1", "child-1", 1, 1);
  });

  it("synthesizes the participant Run's execution view from its thread message rows and paginates", async () => {
    // 同源改造：participant 执行视图来自消息行合成，不再读 run_steps 归档。
    const threadRows = [
      {
        id: "child-run:intent:0", seq: 2, role: "assistant", content_parts: [{ type: "thinking", text: "需要工具", round: 1, complete: true }, { type: "text", text: "查一下" }],
        metadata: { run_id: "child-run", msg_type: "intent", round: 1, agent_name: "child" },
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      {
        id: "child-run:tool:call-1", seq: 3, role: "tool", content_parts: [{ type: "text", text: "data" }], metadata: { run_id: "child-run", msg_type: "observation" },
        tool_call_id: "call-1", name: "read",
      },
    ];
    const listMessages = vi.fn(async () => ({ items: threadRows, total: 2 }));
    const childRun = run("child-run", { parent_run_id: "root-run" });
    const repository = {
      getRun: vi.fn(async () => childRun),
      listMessages,
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listParticipantRunExecutionSteps({
      sessionId: "session-1",
      participantId: "child-1",
      runId: "child-run",
      limit: 2,
      offset: 3,
    });

    // 合成 6 条（agent_started 开篇 + reasoning_complete + intent_complete + tool_call
    // + tool_result + agent_ended 终态收口）
    // → limit 2 offset 3 切到 [tool_call, tool_result]，还有剩余（has_more）
    expect(result.run_id).toBe("child-run");
    expect(result.total).toBe(6);
    expect(result.items.map((item) => item.type)).toEqual(["tool_call", "tool_result"]);
    expect(result.has_more).toBe(true);
    expect(listMessages).toHaveBeenCalledWith("session-1", 10_000, 0, "child:child-1");
  });

  it("rejects a Run owned by another participant", async () => {
    const repository = {
      getRun: vi.fn(async () => run("other-run", { child_agent_id: "child-2", thread_key: "child:child-2" })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    await expect(sessions.listParticipantRunExecutionSteps({
      sessionId: "session-1",
      participantId: "child-1",
      runId: "other-run",
    })).rejects.toThrow("Run 不存在: other-run");
  });

  it("serves the same synthesized execution view for every message of a Run", async () => {
    // 同源改造：同一 run 的任意消息问出的执行视图一致（整 run 合成）；
    // 无 run_id 的消息返回空。
    const messages = [
      { id: "initial", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run" }, thread_key: "root", child_agent_id: null, seq: 1 },
      { id: "assistant", role: "assistant", metadata: { run_id: "root-run" }, thread_key: "root", child_agent_id: null, seq: 4 },
      { id: "standalone", role: "user", metadata: {}, thread_key: "root", child_agent_id: null, seq: 5 },
    ];
    const threadRows = [
      { id: "initial", seq: 1, role: "user", content_parts: [{ type: "text", text: "任务" }], metadata: { run_id: "root-run" }, tool_calls: [] },
      {
        id: "root-run:intent:0", seq: 2, role: "assistant", content_parts: [{ type: "text", text: "我来看看" }], metadata: { run_id: "root-run", msg_type: "round", round: 1, agent_name: "agent" },
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      {
        id: "root-run:tool:call-1", seq: 3, role: "tool", content_parts: [{ type: "text", text: "data" }], metadata: { run_id: "root-run", msg_type: "observation" },
        tool_call_id: "call-1", name: "read",
      },
    ];
    const repository = {
      getMessageById: vi.fn(async (_sessionId: string, messageId: string) => (
        messages.find((message) => message.id === messageId) ?? null
      )),
      listMessages: vi.fn(async () => ({ items: threadRows, total: 2 })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const fromUser = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "initial" });
    const fromFinal = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "assistant" });
    const standalone = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "standalone" });

    expect(fromUser.items).toEqual(fromFinal.items);
    expect(fromFinal.items.map((item) => [item.type, (item.payload as Record<string, unknown>).phase ?? null])).toEqual([
      ["agent_started", "start"],
      ["stream_output", "intent_complete"],
      ["tool_call", "start"],
      ["tool_result", "end"],
      ["agent_ended", "end"],
    ]);
    expect(standalone.items).toEqual([]);
  });

  it("segments the execution view per boundary when an interjection was claimed mid-run", async () => {
    // 插嘴被同 run 认领：消息表两条用户行共享 run_id，行上 boundary_message_id 盖章分段。
    // 每个用户行的执行视图只含自己段内的轮次，不再整 run 复制。
    const messages = [
      { id: "u1", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run" }, thread_key: "root", child_agent_id: null, seq: 1 },
      { id: "u2", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run", execution_kind: "session_followup", source: "running_session" }, thread_key: "root", child_agent_id: null, seq: 5 },
    ];
    const threadRows = [
      { id: "u1", seq: 1, role: "user", content_parts: [{ type: "text", text: "任务" }], metadata: { run_id: "root-run" }, tool_calls: [] },
      {
        id: "root-run:intent:0", seq: 2, role: "assistant", content_parts: [{ type: "text", text: "第一轮说明" }], metadata: { run_id: "root-run", msg_type: "round", round: 1, agent_name: "agent", boundary_message_id: "u1" },
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      {
        id: "root-run:tool:call-1", seq: 3, role: "tool", content_parts: [{ type: "text", text: "data" }], metadata: { run_id: "root-run", msg_type: "observation", boundary_message_id: "u1" },
        tool_call_id: "call-1", name: "read",
      },
      { id: "u2", seq: 5, role: "user", content_parts: [{ type: "text", text: "插嘴" }], metadata: { run_id: "root-run", execution_kind: "session_followup" }, tool_calls: [] },
      {
        id: "root-run:intent:1", seq: 6, role: "assistant", content_parts: [{ type: "text", text: "插嘴后说明" }], metadata: { run_id: "root-run", msg_type: "round", round: 2, agent_name: "agent", boundary_message_id: "u2" },
        tool_calls: [{ id: "call-2", type: "function", function: { name: "search", arguments: "{}" } }],
      },
      {
        id: "root-run:tool:call-2", seq: 7, role: "tool", content_parts: [{ type: "text", text: "hit" }], metadata: { run_id: "root-run", msg_type: "observation", boundary_message_id: "u2" },
        tool_call_id: "call-2", name: "search",
      },
      {
        id: "root-run:final", seq: 8, role: "assistant", content_parts: [{ type: "thinking", text: "收尾", complete: true }, { type: "text", text: "最终答案" }],
        metadata: { run_id: "root-run", msg_type: "round", agent_name: "agent", boundary_message_id: "u2" },
        tool_calls: [],
      },
    ];
    const repository = {
      getMessageById: vi.fn(async (_sessionId: string, messageId: string) => (
        messages.find((message) => message.id === messageId) ?? null
      )),
      listMessages: vi.fn(async () => ({ items: threadRows, total: threadRows.length })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const first = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "u1" });
    const second = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "u2" });

    const shape = (items: { type: string; payload?: unknown }[]) =>
      items.map((item) => [item.type, (item.payload as Record<string, unknown>).phase ?? null]);
    expect(shape(first.items)).toEqual([
      ["agent_started", "start"],
      ["stream_output", "intent_complete"],
      ["tool_call", "start"],
      ["tool_result", "end"],
      ["agent_ended", "end"],
    ]);
    expect(shape(second.items)).toEqual([
      ["agent_started", "start"],
      ["stream_output", "intent_complete"],
      ["tool_call", "start"],
      ["tool_result", "end"],
      ["stream_output", "reasoning_complete"],
      ["agent_ended", "end"],
    ]);
    // 段间不重复：两段各一个工具，合起来恰为全量。
    const toolCalls = (items: { type: string; payload?: unknown }[]) =>
      items.filter((item) => item.type === "tool_call")
        .map((item) => (item.payload as Record<string, unknown>).tool);
    expect(toolCalls(first.items)).toEqual(["read"]);
    expect(toolCalls(second.items)).toEqual(["search"]);
  });

  it("attributes unmarked legacy rows to the nearest preceding boundary by seq", async () => {
    // 旧行（无 boundary_message_id 盖章）按 seq 归属最近前置用户行，分段语义不受影响。
    const messages = [
      { id: "u1", role: "user", metadata: { run_id: "root-run" }, thread_key: "root", child_agent_id: null, seq: 1 },
      { id: "u2", role: "user", metadata: { run_id: "root-run", execution_kind: "session_followup" }, thread_key: "root", child_agent_id: null, seq: 4 },
    ];
    const threadRows = [
      { id: "u1", seq: 1, role: "user", content_parts: [{ type: "text", text: "任务" }], metadata: { run_id: "root-run" }, tool_calls: [] },
      {
        id: "root-run:intent:0", seq: 2, role: "assistant", content_parts: [{ type: "text", text: "第一轮" }], metadata: { run_id: "root-run", msg_type: "round", round: 1, agent_name: "agent" },
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { id: "u2", seq: 4, role: "user", content_parts: [{ type: "text", text: "插嘴" }], metadata: { run_id: "root-run" }, tool_calls: [] },
      {
        id: "root-run:final", seq: 5, role: "assistant", content_parts: [{ type: "thinking", text: "思考", complete: true }, { type: "text", text: "答案" }],
        metadata: { run_id: "root-run", msg_type: "round", agent_name: "agent" },
        tool_calls: [],
      },
    ];
    const repository = {
      getMessageById: vi.fn(async (_sessionId: string, messageId: string) => (
        messages.find((message) => message.id === messageId) ?? null
      )),
      listMessages: vi.fn(async () => ({ items: threadRows, total: threadRows.length })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const first = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "u1" });
    const second = await sessions.listMessageExecution({ sessionId: "session-1", messageId: "u2" });

    expect(first.items.map((item) => item.type)).toEqual(["agent_started", "stream_output", "tool_call", "agent_ended"]);
    expect(second.items.map((item) => item.type)).toEqual(["agent_started", "stream_output", "agent_ended"]);
  });

  it("delegates rollback truncation to the repository transaction", async () => {
    const deleteMessagesAfter = vi.fn(async () => 2);
    const repository = {
      deleteMessagesAfter,
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const deleted = await sessions.rollbackMessages({ sessionId: "session-1", afterSeq: 1 });

    expect(deleted).toBe(2);
    expect(deleteMessagesAfter).toHaveBeenCalledWith("session-1", {
      afterSeq: 1,
    });
  });
});

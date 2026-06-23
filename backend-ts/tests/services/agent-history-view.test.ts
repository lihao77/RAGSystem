import { describe, expect, it } from "vitest";

import { messagesToConversation } from "../../src/services/agent/context-builder/history-view.js";
import type { MessageInfo } from "../../src/contracts/session.js";

function assistantWithToolCalls(callIds: string[], content = ""): MessageInfo {
  return {
    id: "a1",
    seq: 1,
    session_id: "s1",
    role: "assistant",
    content,
    metadata: {},
    tool_calls: callIds.map((id) => ({
      id,
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    })),
    tool_call_id: null,
    name: null,
  } as unknown as MessageInfo;
}

function toolResult(callId: string, content = "ok"): MessageInfo {
  return {
    id: `t-${callId}`,
    seq: 2,
    session_id: "s1",
    role: "tool",
    content,
    metadata: {},
    tool_calls: [],
    tool_call_id: callId,
    name: "read_file",
  } as unknown as MessageInfo;
}

describe("messagesToConversation 悬空 tool_use 契约保证", () => {
  it("为无配对 tool result 的 tool_use 补占位 role:tool", () => {
    const conv = messagesToConversation([assistantWithToolCalls(["call_x"], "查一下")]);
    expect(conv).toEqual([
      expect.objectContaining({ role: "assistant", content: "查一下" }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_x", content: "工具未返回结果" }),
    ]);
  });

  it("已有配对 tool result 不补占位", () => {
    const conv = messagesToConversation([assistantWithToolCalls(["call_done"]), toolResult("call_done")]);
    const tools = conv.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool_call_id: "call_done", content: "ok" });
  });

  it("部分配对：只为悬空 tool_use 补占位", () => {
    const conv = messagesToConversation([
      assistantWithToolCalls(["call_ok", "call_dangling"]),
      toolResult("call_ok"),
    ]);
    const tools = conv.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.tool_call_id).sort()).toEqual(["call_dangling", "call_ok"]);
    const placeholder = tools.find((m) => m.tool_call_id === "call_dangling");
    expect(placeholder?.content).toBe("工具未返回结果");
  });

  it("多个悬空 tool_use 逐个补占位", () => {
    const conv = messagesToConversation([assistantWithToolCalls(["call_a", "call_b"])]);
    const tools = conv.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.tool_call_id).sort()).toEqual(["call_a", "call_b"]);
    expect(tools.every((m) => m.content === "工具未返回结果")).toBe(true);
  });

  it("无 tool_calls 的消息不受影响", () => {
    const userMsg = {
      id: "u1",
      seq: 1,
      session_id: "s1",
      role: "user",
      content: "hi",
      metadata: {},
      tool_calls: [],
      tool_call_id: null,
      name: null,
    } as unknown as MessageInfo;
    expect(messagesToConversation([userMsg])).toEqual([{ role: "user", content: "hi" }]);
  });
});

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@ragsystem/agent-llm";

import { selectLostObservations } from "../src/services/agent/sdk/lost-observations.js";

function assistantWithCalls(...ids: string[]): ChatMessage {
  return {
    role: "assistant",
    content: "intent",
    tool_calls: ids.map((id) => ({ id, type: "function" as const, function: { name: "grep", arguments: "{}" } })),
  };
}

function toolResult(id: string): ChatMessage {
  return { role: "tool", tool_call_id: id, name: "grep", content: `result-${id}` };
}

describe("selectLostObservations 回补配对收窄", () => {
  it("正常压缩场景:历史 tool 消息的 tool_use 已被摘要替换,不回补", () => {
    // 复刻 session 8be9d5a1 失败现场:工作副本含全部历史 tool 消息,rebuilt 只剩摘要+保留尾部(无 tool)。
    const ctxMessages: ChatMessage[] = [
      { role: "user", content: "task-1" },
      assistantWithCalls("h1", "h2"),
      toolResult("h1"),
      toolResult("h2"),
      { role: "assistant", content: "final-1" },
      { role: "user", content: "task-2" },
    ];
    const rebuilt: ChatMessage[] = [
      { role: "assistant", content: "摘要" },
      { role: "assistant", content: "final-1" },
      { role: "user", content: "task-2" },
    ];
    expect(selectLostObservations(ctxMessages, rebuilt)).toEqual([]);
  });

  it("崩溃恢复场景:悬空 tool_use 仍在保留区,未落库的 observation 被回补", () => {
    const ctxMessages: ChatMessage[] = [
      { role: "user", content: "task" },
      assistantWithCalls("r1", "r2"),
      toolResult("r1"),
      toolResult("r2"), // r2 重执行后尚未落库
    ];
    const rebuilt: ChatMessage[] = [
      { role: "assistant", content: "摘要" },
      { role: "user", content: "task" },
      assistantWithCalls("r1", "r2"),
      toolResult("r1"), // r1 已落库,在 rebuilt 里
    ];
    const lost = selectLostObservations(ctxMessages, rebuilt);
    expect(lost).toEqual([toolResult("r2")]);
  });

  it("rebuilt 已有的 observation 不重复回补", () => {
    const ctxMessages: ChatMessage[] = [assistantWithCalls("k1"), toolResult("k1")];
    const rebuilt: ChatMessage[] = [assistantWithCalls("k1"), toolResult("k1")];
    expect(selectLostObservations(ctxMessages, rebuilt)).toEqual([]);
  });

  it("tool_use 不在 rebuilt 的孤儿 observation 不回补(边界:rebuilt 完全没有 assistant tool_calls)", () => {
    const ctxMessages: ChatMessage[] = [toolResult("x1"), toolResult("x2")];
    const rebuilt: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(selectLostObservations(ctxMessages, rebuilt)).toEqual([]);
  });
});

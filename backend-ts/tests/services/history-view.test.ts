import { describe, expect, it } from "vitest";

import { messagesToConversation } from "../../src/services/agent/context/history-view.js";
import type { MessageInfo } from "../../src/contracts/session.js";

const mk = (msg: object): MessageInfo => msg as unknown as MessageInfo;

describe("messagesToConversation", () => {
  it("悬空 tool_use 不补占位 observation(保留供 SDK 通用开始契约恢复时重执行)", () => {
    const messages: MessageInfo[] = [
      mk({ seq: 1, role: "user", content: "跑命令", thread_key: "root", metadata: { msg_type: "user" } }),
      mk({
        seq: 2,
        role: "assistant",
        content: "",
        thread_key: "root",
        tool_calls: [{ id: "call_1", function: { name: "execute_bash", arguments: '{"command":"ls"}' } }],
        metadata: { msg_type: "intent", run_id: "r1" },
      }),
    ];
    const { conversation, originals } = messagesToConversation(messages);

    expect(conversation).toHaveLength(2);
    expect(conversation[1].role).toBe("assistant");
    expect(conversation[1].tool_calls?.[0]?.id).toBe("call_1");
    expect(conversation.some((m) => m.role === "tool" && m.content === "工具未返回结果")).toBe(false);
    expect(originals).toHaveLength(2);
    expect(originals.every((m) => m !== null)).toBe(true);
  });

  it("已配对 tool_use 正常保留 tool observation", () => {
    const messages: MessageInfo[] = [
      mk({ seq: 1, role: "user", content: "x", thread_key: "root", metadata: {} }),
      mk({
        seq: 2,
        role: "assistant",
        content: "",
        thread_key: "root",
        tool_calls: [{ id: "call_1", function: { name: "t", arguments: "{}" } }],
        metadata: {},
      }),
      mk({ seq: 3, role: "tool", content: "结果", tool_call_id: "call_1", name: "t", thread_key: "root", metadata: {} }),
    ];
    const { conversation } = messagesToConversation(messages);

    expect(conversation).toHaveLength(3);
    expect(conversation[2]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "结果" });
  });
});

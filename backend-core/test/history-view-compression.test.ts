import { describe, expect, it } from "vitest";

import { messagesToConversation, resolveCompressionView } from "../src/services/agent/context/history-view.js";
import { MSG_TYPE } from "../src/contracts/message-kinds.js";
import type { MessageInfo } from "../src/contracts/session/session.js";

let seqCounter = 0;
function msg(role: MessageInfo["role"], extra: Partial<MessageInfo> = {}): MessageInfo {
  seqCounter += 1;
  return {
    id: `m${seqCounter}`,
    seq: seqCounter,
    session_id: "s",
    role,
    content: `${role}-${seqCounter}`,
    content_parts: [],
    metadata: {},
    created_at: "",
    thread_key: "root",
    child_agent_id: null,
    ...extra,
  };
}

describe("resolveCompressionView 摘要消息形态", () => {
  it("摘要对模型以 user role 呈现(存储层 assistant 不动),且替换区间严格按 replaces_up_to_seq", () => {
    seqCounter = 0;
    const history: MessageInfo[] = [
      msg("user"),
      msg("assistant"),
      msg("assistant", {
        content: "本次会话从之前的对话继续，以下是该对话早期内容的摘要。摘要之后是最近未压缩的原始对话，与摘要内容不重叠。\n\nSummary:\n...",
        metadata: { msg_type: MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY, replaces_up_to_seq: 2 },
      }),
      msg("user"),
      msg("assistant"),
    ];
    const view = resolveCompressionView(history);
    expect(view).toHaveLength(3);
    expect(view[0]?.role).toBe("user");
    expect(view[0]?.metadata.msg_type).toBe(MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY);
    expect(view[0]?.content).toContain("摘要");
    expect(view[1]?.seq).toBe(4);
    expect(view[2]?.seq).toBe(5);
    expect(messagesToConversation(view).conversation.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  });
});

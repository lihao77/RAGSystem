import { describe, expect, it } from "vitest";

import { SessionMessageSchema } from "@ragsystem/api-contracts";
import type { MessageInfo } from "../src/contracts/session/session.js";
import { stripPrivateMessageFields } from "../src/services/sessions/index.js";

const messageWithProviderState = {
  seq: 2,
  id: "run-1:intent:1",
  session_id: "session-1",
  role: "assistant",
  content: "正文",
  content_parts: [{ type: "text", text: "正文" }],
  metadata: { msg_type: "intent" },
  thread_key: "root",
  child_agent_id: null,
  created_at: "2026-08-22T00:00:00.000Z",
  tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
  provider_state: {
    provider_key: "kimi",
    model: "k3",
    state: {
      protocol: "anthropic_messages",
      toolCallIds: ["call-1"],
      blocks: [{ type: "thinking", thinking: "hidden", signature: "sig" }],
    },
  },
} as MessageInfo;

describe("stripPrivateMessageFields", () => {
  it("removes provider_state so messages pass the strict client contract", () => {
    const stripped = stripPrivateMessageFields(messageWithProviderState);
    expect("provider_state" in stripped).toBe(false);

    // 与 /sessions/:id/messages 路由的响应校验同源：strict schema 必须接受剥离后的消息。
    expect(() => SessionMessageSchema.parse(stripped)).not.toThrow();
  });

  it("keeps provider_state out of JSON payloads entirely", () => {
    const json = JSON.stringify(stripPrivateMessageFields(messageWithProviderState));
    expect(json).not.toContain("provider_state");
    expect(json).not.toContain("anthropic_messages");
  });
});

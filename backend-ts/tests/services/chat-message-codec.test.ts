import { describe, expect, it } from "vitest";

import { decodeChatFields, encodeChatFields } from "../../src/services/stores/conversation-store/chat-message-codec.js";

const toolCall = {
  id: "call_1",
  type: "function" as const,
  function: { name: "search", arguments: "{\"q\":\"x\"}" },
};

describe("chat-message-codec", () => {
  it("encodes structured fields into metadata.chat_fields", () => {
    const encoded = encodeChatFields(
      { foo: "bar" },
      { tool_calls: [toolCall], tool_call_id: "call_1", name: "search" },
    );
    expect(encoded).toEqual({
      foo: "bar",
      chat_fields: { tool_calls: [toolCall], tool_call_id: "call_1", name: "search" },
    });
  });

  it("returns metadata as-is (same reference) when no structured fields", () => {
    const metadata = { foo: "bar" };
    expect(encodeChatFields(metadata, {})).toBe(metadata);
  });

  it("omits empty tool_calls array (treats as no fields)", () => {
    expect(encodeChatFields({}, { tool_calls: [] })).toEqual({});
  });

  it("decodes structured fields round-trip", () => {
    const encoded = encodeChatFields(
      { foo: "bar" },
      { tool_calls: [toolCall], tool_call_id: "call_1", name: "search" },
    );
    expect(decodeChatFields(encoded)).toEqual({
      tool_calls: [toolCall],
      tool_call_id: "call_1",
      name: "search",
    });
  });

  it("decodes empty when no chat_fields", () => {
    expect(decodeChatFields({ foo: "bar" })).toEqual({});
  });

  it("preserves existing metadata keys alongside chat_fields", () => {
    const encoded = encodeChatFields({ msg_type: "observation", round: 2 }, { name: "search" });
    expect(encoded.msg_type).toBe("observation");
    expect(encoded.round).toBe(2);
    expect(decodeChatFields(encoded)).toEqual({ name: "search" });
  });
});

import { describe, expect, it } from "vitest";
import {
  isParticipantConversationMessageVisible,
  isRootUserRevisionAnchor,
} from "../src/contracts/session/message-visibility.js";

const message = (metadata: Record<string, unknown>, threadKey = "child:one") => ({
  role: "user" as const,
  metadata,
  thread_key: threadKey,
  child_agent_id: threadKey === "root" ? null : "one",
});

describe("participant conversation message visibility", () => {
  it("exposes claimed Agent messages without exposing unrelated hidden records", () => {
    expect(isParticipantConversationMessageVisible(
      message({ agent_message: true, visible_to_user: false }),
      "child:one",
    )).toBe(true);
    expect(isParticipantConversationMessageVisible(
      message({ visible_to_user: false }),
      "child:one",
    )).toBe(false);
  });

  it("uses the same rule for Agent messages delivered to the root participant", () => {
    expect(isParticipantConversationMessageVisible(
      message({ agent_message: true, visible_to_user: false, conversation_scope: "agent" }, "root"),
      "root",
    )).toBe(true);
  });
});

describe("root user revision anchors", () => {
  it("accepts only visible human-facing root user messages", () => {
    expect(isRootUserRevisionAnchor(message({}, "root"))).toBe(true);
    expect(isRootUserRevisionAnchor(message({ agent_message: true }, "root"))).toBe(false);
    expect(isRootUserRevisionAnchor(message({ hidden: true }, "root"))).toBe(false);
    expect(isRootUserRevisionAnchor(message({}, "child:1"))).toBe(false);
    expect(isRootUserRevisionAnchor({ ...message({}, "root"), role: "assistant" })).toBe(false);
  });
});

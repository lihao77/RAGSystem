import { describe, expect, it, vi } from "vitest";

import { MSG_TYPE } from "../src/contracts/message-kinds.js";
import type { MessageInfo } from "../src/contracts/session/session.js";
import { ProjectionRegistry } from "../src/services/agent/context/extensions/registry.js";
import { RecentMessagesContextSource } from "../src/services/agent/context/recent-messages-source.js";

function message(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    id: "message-1",
    seq: 1,
    session_id: "session-1",
    role: "assistant",
    content: "",
    content_parts: [],
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    thread_key: "root",
    child_agent_id: null,
    ...overrides,
  };
}

describe("RecentMessagesContextSource", () => {
  it("preserves every tool observation until a formal compression summary replaces it", async () => {
    const history = Array.from({ length: 7 }, (_, index) => {
      const callId = `call-${index + 1}`;
      const content = `complete observation ${index + 1}`;
      return [
        message({
          id: `intent-${index + 1}`,
          seq: index * 2 + 1,
          metadata: { msg_type: MSG_TYPE.INTENT },
          tool_calls: [{
            id: callId,
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        }),
        message({
          id: `observation-${index + 1}`,
          seq: index * 2 + 2,
          role: "tool",
          content,
          content_parts: [{ type: "text", text: content }],
          metadata: { msg_type: MSG_TYPE.OBSERVATION },
          tool_call_id: callId,
          name: "read",
        }),
      ];
    }).flat();
    const historyPort = {
      getRecentMessages: vi.fn(async () => history),
    };
    const source = new RecentMessagesContextSource(
      historyPort,
      false,
      new ProjectionRegistry(),
    );

    const result = await source.build({
      sessionId: "session-1",
      threadKey: "root",
      cacheAlive: false,
      touch: false,
    });

    expect(result.conversation?.filter((entry) => entry.role === "tool").map((entry) => entry.content)).toEqual(
      Array.from({ length: 7 }, (_, index) => `complete observation ${index + 1}`),
    );
  });
});

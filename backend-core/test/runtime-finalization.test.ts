import { describe, expect, it } from "vitest";

import { buildInterruptedToolMessages } from "../src/contracts/storage/runtime-finalization.js";
import type { MessageInfo } from "../src/contracts/session/session.js";

describe("buildInterruptedToolMessages", () => {
  it("closes a dangling tool call resumed from an older run", () => {
    const messages = [
      {
        id: "old-run:intent:1",
        seq: 1,
        session_id: "session-1",
        role: "assistant",
        content: "searching",
        metadata: { run_id: "old-run", round: 1 },
        created_at: "2026-01-01T00:00:00.000Z",
        thread_key: "root",
        child_agent_id: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "execute_bash", arguments: '{"command":"find /"}' },
        }],
      },
    ] as MessageInfo[];

    const [closed] = buildInterruptedToolMessages(messages, {
      sessionId: "session-1",
      runId: "current-run",
      threadKey: "root",
      agentName: "agent-1",
    });

    expect(closed).toMatchObject({
      messageId: "current-run:tool:call-1",
      role: "tool",
      toolCallId: "call-1",
      name: "execute_bash",
      content: "工具执行被中断",
      metadata: {
        interrupted: true,
        run_id: "current-run",
      },
    });
  });
});

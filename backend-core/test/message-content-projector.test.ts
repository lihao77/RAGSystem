import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@ragsystem/agent-llm";

import type { MessageInfo } from "../src/contracts/session/session.js";
import {
  hasAgentVisibleMessageContent,
  projectCanonicalMessageContent,
} from "../src/services/agent/context/message-content-projector.js";

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

describe("projectCanonicalMessageContent", () => {
  it("projects assistant files from content_parts instead of the display-only content field", async () => {
    const conversation: ChatMessage[] = [{ role: "assistant", content: "File: stale label (results/map.png)" }];
    const raw = message({
      content: "File: stale label (results/map.png)",
      content_parts: [
        { type: "text", text: "Current map: " },
        { type: "file_ref", file_path: "results/map.png", presentation: "inline", caption: "Risk map" },
      ],
    });

    await projectCanonicalMessageContent(conversation, [raw], {
      sessionId: "session-1",
      supportsVision: false,
      readAttachment: vi.fn(),
    });

    expect(conversation[0]?.content).toBe(
      'Current map: \n<file_ref path="results/map.png" presentation="inline" caption="Risk map"/>',
    );
    expect(conversation[0]?.content).not.toContain("File:");
  });

  it("projects slash command snapshots and authoritative attachments from one ordered content_parts array", async () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "/review src" }];
    const raw = message({
      role: "user",
      content: "/review src",
      content_parts: [
        {
          type: "command_ref",
          invocation_id: "cmd-1",
          name: "review",
          args: "src",
          raw_text: "/review src",
          resolution: {
            kind: "prompt",
            agent_text: "Review the source tree",
            snapshot_id: "sha256:test",
          },
        },
        {
          type: "attachment_ref",
          file_id: "file-1",
          original_name: "input.nc",
          stored_name: "file-1_input.nc",
          mime: "application/x-netcdf",
          size: 12,
          kind: "file",
          presentation: "attachment",
          file_path: "D:/data/input.nc",
          file_path_space: "absolute",
        },
      ],
      metadata: {},
    });

    await projectCanonicalMessageContent(conversation, [raw], {
      sessionId: "session-1",
      supportsVision: false,
      readAttachment: vi.fn(),
    });

    expect(conversation[0]?.content).toBe(
      'Review the source tree\n<attachments version="1"><attachment file_id="file-1" name="input.nc" mime="application/x-netcdf" size="12" kind="file" file_path="D:/data/input.nc" file_path_space="absolute"/></attachments>',
    );
    expect(raw.content).toBe("/review src");
  });

  it("excludes system commands and command results from the Agent view by part semantics", () => {
    expect(hasAgentVisibleMessageContent([{
      type: "command_ref",
      invocation_id: "cmd-1",
      name: "help",
      args: "",
      raw_text: "/help",
      resolution: { kind: "system" },
    }], "user")).toBe(false);
    expect(hasAgentVisibleMessageContent([{
      type: "command_result",
      invocation_id: "cmd-1",
      name: "help",
      success: true,
      text: "可用命令",
    }], "system")).toBe(false);
  });
});

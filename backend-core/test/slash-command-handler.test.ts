import { describe, expect, it, vi } from "vitest";

import type { ExecutionSessionPort } from "../src/contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "../src/services/agent/execution/runtime-core-service.js";
import type { AgentExecutionStatusTracker } from "../src/services/agent/execution/status-tracker.js";
import type { TenantId } from "../src/identity/types.js";
import type { ClientEventPublisher } from "../src/services/runtime/event-outbox/client-event-publisher.js";
import type { RuntimeStorage } from "../src/contracts/storage/runtime-storage.js";
import {
  createCommandRefPart,
  parseSlashCommand,
  SlashCommandHandler,
} from "../src/services/agent/execution/slash-command-handler.js";

describe("slash command content semantics", () => {
  it("captures prompt command Agent text in a stable command_ref snapshot", () => {
    const command = parseSlashCommand("/review src/app.ts");
    expect(command).toMatchObject({
      name: "review",
      args: "src/app.ts",
      mode: "prompt",
    });

    const first = createCommandRefPart(command!, "/review src/app.ts", "cmd-fixed");
    const second = createCommandRefPart(command!, "/review src/app.ts", "cmd-fixed");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      type: "command_ref",
      invocation_id: "cmd-fixed",
      raw_text: "/review src/app.ts",
      resolution: {
        kind: "prompt",
        agent_text: "请对以下内容进行全面的代码审查，包括代码质量、安全性和性能优化建议：src/app.ts",
        snapshot_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
  });

  it("stores a system command_ref and its correlated command_result", async () => {
    const added: Array<Record<string, unknown>> = [];
    const sessions = {
      getSession: vi.fn(async () => ({ session_id: "session-1" })),
      addMessage: vi.fn(async (input: Record<string, unknown>) => {
        const message = {
          id: `message-${added.length + 1}`,
          ...input,
          content_parts: input.contentParts,
        };
        added.push(message);
        return message;
      }),
    } as unknown as ExecutionSessionPort;
    const clientEvents = { publish: vi.fn(async () => undefined) } as unknown as ClientEventPublisher;
    const handler = new SlashCommandHandler(
      "tenant-1" as TenantId,
      sessions,
      {} as AgentExecutionStatusTracker,
      {} as RuntimeExecutionConfigResolver,
      () => [],
      null,
      clientEvents,
      { operations: {} } as RuntimeStorage,
    );

    const command = parseSlashCommand("/help")!;
    const result = await handler.handle({
      sessionId: "session-1",
      sessionIdentity: {
        sessionId: "session-1",
        ownerUserId: "user-1",
        visibility: "private",
        originType: "direct",
        originId: null,
        originChannel: "web",
        workspaceId: null,
        metadata: {},
        permissionMode: null,
      },
      userId: "user-1",
      requestId: "request-1",
      selectedLlm: "",
      command,
      originalTask: "/help",
    });

    expect(result?.success).toBe(true);
    expect(result?.contentParts).toEqual([expect.objectContaining({
      type: "command_result",
      name: "help",
      success: true,
      text: expect.any(String),
    })]);
    expect(added).toHaveLength(2);
    expect(added[0]?.contentParts).toEqual([expect.objectContaining({
      type: "command_ref",
      name: "help",
      raw_text: "/help",
      resolution: { kind: "system" },
    })]);
    const commandRef = (added[0]?.contentParts as Array<{ invocation_id: string }>)[0]!;
    expect(added[1]?.contentParts).toEqual([expect.objectContaining({
      type: "command_result",
      invocation_id: commandRef.invocation_id,
      name: "help",
      success: true,
    })]);
    expect(added[0]?.metadata).toEqual({});
    expect(added[1]?.metadata).toEqual({});
    expect(clientEvents.publish).toHaveBeenCalledTimes(2);
    expect(clientEvents.publish).toHaveBeenNthCalledWith(
      1,
      "session-1",
      expect.objectContaining({
        type: "state_sync",
        payload: expect.objectContaining({
          category: "message_saved",
          ref: expect.objectContaining({ content_parts: expect.any(Array) }),
        }),
      }),
      expect.any(Object),
    );
  });
});

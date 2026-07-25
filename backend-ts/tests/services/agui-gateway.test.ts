import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";

import type { ExecutionApplication } from "../../src/contracts/execution/execution-application.js";
import type { RuntimeContainer } from "../../src/contracts/runtime/runtime-container.js";
import type { InteractionCoordinator } from "../../src/contracts/runtime/pending-interactions.js";
import type { UserId } from "../../src/identity/types.js";
import { AguiGateway } from "../../src/services/agui-gateway/agui-handler.js";

describe("AguiGateway", () => {
  it("adapts a shared-entry slash command into a completed AG-UI text run", async () => {
    const chunks: string[] = [];
    const requestRaw = new EventEmitter();
    const raw = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
      end: vi.fn(() => { raw.writableEnded = true; }),
    };
    const reply = {
      hijack: vi.fn(),
      raw,
      request: { raw: requestRaw },
    } as unknown as FastifyReply;
    const unsubscribe = vi.fn();
    const container = {
      realtimeEvents: { subscribe: vi.fn(() => unsubscribe) },
      hostToolRegistry: { register: vi.fn() },
    } as unknown as RuntimeContainer;
    const execution = {
      startStream: vi.fn(async () => ({
        started: true,
        session_id: "thread-1",
        kind: "command" as const,
        command_result: { success: true, content: "available commands" },
      })),
    } as unknown as ExecutionApplication;
    const gateway = new AguiGateway(
      container,
      "usr_test" as UserId,
      execution,
      {} as InteractionCoordinator,
    );

    await gateway.handle({
      threadId: "thread-1",
      runId: "external-run-1",
      messages: [{ role: "user", content: "/help" }],
    }, reply);

    const events = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length).trim()) as { type: string; delta?: string });
    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[2]?.delta).toBe("available commands");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
  });
});

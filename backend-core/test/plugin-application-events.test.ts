import { describe, expect, it, vi } from "vitest";

import type { BackendPlugin } from "../src/plugins/backend-plugin.js";
import { BackendPluginManager } from "../src/plugins/plugin-manager.js";
import { SESSION_DELETED_EVENT } from "../src/contracts/runtime/entity-lifecycle-events.js";

function subscriberPlugin(id: string, onEvent: (payload: unknown) => Promise<void>): BackendPlugin {
  return {
    manifest: { id, version: "1.0.0" },
    register(context) {
      context.events.on(SESSION_DELETED_EVENT, onEvent);
    },
  };
}

describe("plugin application event dispatch", () => {
  it("isolates handler failures so remaining subscribers still run and emit does not throw", async () => {
    const handled: string[] = [];
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: () => logger,
      level: "info",
    };
    const manager = new BackendPluginManager([
      subscriberPlugin("broken", async () => {
        handled.push("broken");
        throw new Error("cleanup failed");
      }),
      subscriberPlugin("healthy", async (payload) => {
        handled.push(`healthy:${String((payload as { sessionId?: unknown }).sessionId)}`);
      }),
    ]);

    await manager.register();
    await manager.initializeApplication({ logger: logger as never, registry: null as never });
    await manager.emit(SESSION_DELETED_EVENT, { tenantId: "tnt_a", sessionId: "ses_1" });

    expect(handled).toEqual(["broken", "healthy:ses_1"]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const call = logger.error.mock.calls[0]?.[0] as { pluginId?: string; event?: string };
    expect(call?.pluginId).toBe("broken");
    expect(call?.event).toBe(SESSION_DELETED_EVENT);
  });

  it("still isolates failures when no logger reporter is bound", async () => {
    const manager = new BackendPluginManager([
      subscriberPlugin("broken", async () => {
        throw new Error("cleanup failed");
      }),
    ]);
    await manager.register();
    // 事件始终是尽力通知：未绑定错误记录器时同样不向发布方传播。
    await expect(manager.emit(SESSION_DELETED_EVENT, { tenantId: "tnt_a", sessionId: "ses_1" }))
      .resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import { registerWidgetAndRealtimeRoutes } from "../../src/app/route-assembly.js";
import { registerSessionWebSocketRoute } from "../../src/routes/agent/ws.js";

describe("realtime route assembly", () => {
  it("forwards every request application resolver to the session WebSocket", async () => {
    const calls: Array<{ plugin: unknown; options: Record<string, unknown> }> = [];
    const app = {
      register: vi.fn(async (plugin: unknown, options: Record<string, unknown>) => {
        calls.push({ plugin, options });
      }),
    };
    const resolvers = {
      resolveMemoryApplication: vi.fn(),
      resolveSessionApplication: vi.fn(),
      resolveExecutionRead: vi.fn(),
      resolveExecutionApplication: vi.fn(),
      resolveAnalytics: vi.fn(),
      resolveMonitoringApplication: vi.fn(),
      resolveArtifactApplication: vi.fn(),
    };

    await registerWidgetAndRealtimeRoutes(app as never, {
      registry: {},
      identityProvider: {},
      botRepository: {},
      widgetCredentialStore: {},
      wsTickets: {},
      ...resolvers,
    } as never);

    const websocketRegistration = calls.find((call) => call.plugin === registerSessionWebSocketRoute);
    expect(websocketRegistration?.options).toMatchObject(resolvers);
  });
});

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

describe("session permission routes", () => {
  it("读取 standard 回落并持久化更新当前会话 mode", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const created = await app.inject({ method: "POST", url: "/api/agent/sessions", payload: { session_id: "permission-session" } });
    expect(created.statusCode).toBe(200);

    const initial = await app.inject({ method: "GET", url: "/api/agent/sessions/permission-session/permissions" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ data: { mode: "standard" } });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/agent/sessions/permission-session/permissions",
      payload: { mode: "relaxed" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ data: { mode: "relaxed" } });
    expect(harness.container.conversationStore.getSession("permission-session")?.permission_mode).toBe("relaxed");
  });

  it("全局 permission 端点已彻底移除", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    expect((await app.inject({ method: "GET", url: "/api/permissions/policy" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/permissions/mode", payload: { mode: "relaxed" } })).statusCode).toBe(404);
  });
});

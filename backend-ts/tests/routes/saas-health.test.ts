import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("SaaS health route", () => {
  it("uses the tenant-bound PostgreSQL session application for the session count", async () => {
    const listSessions = vi.fn(async () => ({ items: [], total: 7, limit: 1, offset: 0, has_more: true }));
    const harness = await buildTestHarness({
      resolveSessionApplication: async () => ({ listSessions }) as never,
    });
    app = harness.app;

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: { sessions_count: 7 } });
    expect(listSessions).toHaveBeenCalledWith({ limit: 1, offset: 0, userIds: null });
  });
});

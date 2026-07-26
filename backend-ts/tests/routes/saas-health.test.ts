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
    const listSessionFacets = vi.fn(async () => ({
      typeCounts: { direct: 3, bot: 2, widget: 2 },
      origins: [],
      workspaces: [],
    }));
    const harness = await buildTestHarness({
      resolveSessionApplication: async () => ({ listSessionFacets }) as never,
    });
    app = harness.app;

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: { sessions_count: 7 } });
    expect(listSessionFacets).toHaveBeenCalledWith({
      access: { userId: "usr_local", includeTenant: true },
    });
  });
});

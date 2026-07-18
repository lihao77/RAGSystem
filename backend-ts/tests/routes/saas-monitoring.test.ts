import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";
import type { SaaSMonitoringApplication } from "../../src/services/runtime/saas-monitoring-application.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("SaaS monitoring routes", () => {
  it("routes tenant outbox operations through the async SaaS application", async () => {
    const operations = {
      listOutbox: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0, has_more: false })),
      getOutboxRow: vi.fn(async () => ({ id: 7, event_id: "event-7" })),
      retryOutbox: vi.fn(async () => true),
      retryOutboxBatch: vi.fn(async () => ({ matched: 1, retried: 1, ids: [7] })),
      deleteDeliveredOutbox: vi.fn(async () => 2),
    } as unknown as SaaSMonitoringApplication;
    const harness = await buildTestHarness({ resolveSaaSMonitoringApplication: () => operations });
    app = harness.app;

    expect((await app.inject({ method: "GET", url: "/api/agent/event-outbox?status=failed" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agent/event-outbox/7" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agent/event-outbox/7/retry" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agent/event-outbox/retry", payload: { ids: [7] } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/agent/event-outbox/delivered?before=2999-01-01T00%3A00%3A00.000Z" })).statusCode).toBe(200);

    expect(operations.listOutbox).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["failed"] }));
    expect(operations.getOutboxRow).toHaveBeenCalledWith(7);
    expect(operations.retryOutbox).toHaveBeenCalledWith(7);
    expect(operations.retryOutboxBatch).toHaveBeenCalledWith(expect.objectContaining({ ids: [7] }));
    expect(operations.deleteDeliveredOutbox).toHaveBeenCalledWith(expect.objectContaining({ before: "2999-01-01T00:00:00.000Z" }));
  });
});

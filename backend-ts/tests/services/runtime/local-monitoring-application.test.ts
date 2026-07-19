import { describe, expect, it, vi } from "vitest";

import { LocalMonitoringApplication } from "../../../src/adapters/local/local-monitoring-application.js";

describe("LocalMonitoringApplication", () => {
  it("adapts synchronous outbox operations to the monitoring contract", async () => {
    const store = {
      listOutbox: vi.fn(() => ({ items: [], total: 0, limit: 10, offset: 0, has_more: false })),
      getOutboxRow: vi.fn(() => null),
      retryOutbox: vi.fn(() => true),
      retryOutboxBatch: vi.fn(() => ({ retried: 2, skipped: 0 })),
      deleteDeliveredOutbox: vi.fn(() => 3),
    };
    const monitoring = new LocalMonitoringApplication(store);

    await expect(monitoring.listOutbox({ limit: 10 })).resolves.toMatchObject({ total: 0 });
    await expect(monitoring.getOutboxRow(1)).resolves.toBeNull();
    await expect(monitoring.retryOutbox(1)).resolves.toBe(true);
    await expect(monitoring.retryOutboxBatch({ limit: 2 })).resolves.toEqual({ retried: 2, skipped: 0 });
    await expect(monitoring.deleteDeliveredOutbox({ before: "2026-01-01T00:00:00.000Z" })).resolves.toBe(3);
    expect(store.listOutbox).toHaveBeenCalledWith({ limit: 10 });
    expect(store.retryOutboxBatch).toHaveBeenCalledWith({ limit: 2 });
  });
});

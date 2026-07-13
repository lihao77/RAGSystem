import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

const close = new Array<() => Promise<void>>();
afterEach(async () => { for (const callback of close.splice(0)) await callback(); });

describe("GET /api/bootstrap", () => {
  it("Local profile 隐藏账号与多租户能力", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const response = await harness.app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deployment: "local",
      auth: "local",
      tenancy: "single",
      execution: "local",
      storage: "sqlite",
      ui: "local",
      capabilities: {
        login: false,
        tenantSwitch: false,
        members: false,
        billing: false,
        widget: false,
        localExecution: true,
      },
    });
  });
});

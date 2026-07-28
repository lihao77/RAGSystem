import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("AG-UI browser transport", () => {
  it("preserves CORS headers after hijacking the SSE response", async () => {
    app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agui/",
      headers: { origin: "http://localhost:5122", accept: "text/event-stream" },
      payload: { threadId: "cors-probe", runId: "cors-run", messages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5122");
  });
});

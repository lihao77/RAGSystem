import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { registerArtifactRoutes } from "../dist/routes.js";

test("artifact content route enforces session access and returns binary metadata", async () => {
  const accessCalls = [];
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId: "tenant-a" };
  });
  await app.register(registerArtifactRoutes, dependencies({
    accessCalls,
    getArtifactContent: () => ({
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      filename: "海温 raster.png",
    }),
  }));

  const response = await app.inject({ method: "GET", url: "/art_demo/content" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["content-length"], "4");
  assert.equal(response.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.match(response.headers["content-disposition"], /^inline; filename\*=UTF-8''/);
  assert.deepEqual(response.rawPayload, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual(accessCalls, [{ sessionId: "session-a", notFoundMessage: "未找到 artifact: art_demo" }]);
  await app.close();
});

test("artifact content route does not read content when session access is denied", async () => {
  let contentReads = 0;
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId: "tenant-a" };
  });
  await app.register(registerArtifactRoutes, dependencies({
    assertResourceReadable: async () => {
      const error = new Error("forbidden");
      error.statusCode = 403;
      throw error;
    },
    getArtifactContent: () => { contentReads += 1; return null; },
  }));

  const response = await app.inject({ method: "GET", url: "/art_secret/content" });

  assert.equal(response.statusCode, 403);
  assert.equal(contentReads, 0);
  await app.close();
});

function dependencies(overrides = {}) {
  const accessCalls = overrides.accessCalls ?? [];
  const application = {
    getArtifactSessionId: async () => "session-a",
    getArtifactContent: async () => null,
    getArtifact: async () => ({}),
    listArtifacts: async () => [],
    deleteArtifact: async () => false,
    deleteSessionArtifacts: async () => 0,
    ...overrides,
  };
  return {
    storage: {
      applicationForTenant: async (tenantId) => {
        assert.equal(tenantId, "tenant-a");
        return application;
      },
    },
    sessionAccess: {
      assertReadable: async () => {},
      assertMutable: async () => {},
      assertResourceReadable: overrides.assertResourceReadable ?? (async (_request, sessionId, notFoundMessage) => {
        accessCalls.push({ sessionId, notFoundMessage });
      }),
      assertResourceMutable: async () => {},
    },
  };
}

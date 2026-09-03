import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerWorkspaceFileRoutes } from "../src/routes/agent/workspace-files.js";
import type { SessionApplication } from "../src/contracts/session/session-application.js";
import type { SessionInfo } from "../src/contracts/session/session.js";
import type { WorkspaceFileApplication, WorkspaceFileReadResult } from "../src/contracts/application/workspace-file-application.js";
import type { RequestApplications } from "../src/app/request-applications.js";
import type { AgentRouteOptions } from "../src/routes/route-options.js";
import { LOCAL_USER_ID } from "../src/services/identity/local-identity.js";
import { HttpError } from "../src/utils/errors.js";
import { createTenantId } from "../src/identity/types.js";

const tenantId = createTenantId("tnt_test");
const CONTENT_URL = "/api/agent/sessions/ses_1/workspace-files/content?path=report.md";

interface FileState { body: string; etag: string | null }

function sessionInfo(): SessionInfo {
  return {
    session_id: "ses_1",
    tenant_id: tenantId,
    owner_user_id: "usr_test",
    visibility: "private",
  } as unknown as SessionInfo;
}

async function createApp(state: FileState) {
  const reads: Array<{ sessionId: string; filePath: string }> = [];
  const sessions = {
    getSession: async (sessionId: string) => (sessionId === "ses_1" ? sessionInfo() : null),
  } as unknown as SessionApplication;
  const files: WorkspaceFileApplication = {
    async read(sessionId, filePath): Promise<WorkspaceFileReadResult> {
      reads.push({ sessionId, filePath });
      return {
        status: "found",
        body: new TextEncoder().encode(state.body),
        contentType: "text/plain",
        size: state.body.length,
        path: filePath,
        etag: state.etag,
      };
    },
  };
  const app = Fastify();
  // core-app.ts 的 HttpError → 状态码映射在此测试内以最小形态复刻
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ success: false, code: error.code, message: error.message });
      return;
    }
    reply.code(500).send({ message: error instanceof Error ? error.message : "internal" });
  });
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId, userId: LOCAL_USER_ID, role: "owner", permissions: [] };
    request.applications = { sessions } as unknown as RequestApplications;
  });
  await app.register(registerWorkspaceFileRoutes, {
    prefix: "/api/agent",
    resolveSessionApplication: async () => sessions,
    resolveWorkspaceFileApplication: async () => files,
  } as unknown as AgentRouteOptions);
  return { app, reads };
}

describe("workspace file content route caching headers", () => {
  it("returns etag and no-store, then 304 with empty body on matching If-None-Match", async () => {
    const state = { body: "v1", etag: "local-ws-100-2" };
    const { app, reads } = await createApp(state);
    try {
      const first = await app.inject({ method: "GET", url: CONTENT_URL });
      expect(first.statusCode).toBe(200);
      expect(first.body).toBe("v1");
      expect(first.headers.etag).toBe('"local-ws-100-2"');
      expect(first.headers["cache-control"]).toBe("private, no-store");

      const revalidated = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": '"local-ws-100-2"' } });
      expect(revalidated.statusCode).toBe(304);
      expect(revalidated.body).toBe("");
      expect(revalidated.headers.etag).toBe('"local-ws-100-2"');
      // 304 同样要过读权限与读取路径（不因短路跳过会话校验）
      expect(reads).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("matches weak validators and etag lists, and serves a new body when the etag changes", async () => {
    const state = { body: "v1", etag: "local-ws-100-2" };
    const { app } = await createApp(state);
    try {
      const weak = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": 'W/"local-ws-100-2"' } });
      expect(weak.statusCode).toBe(304);

      const listed = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": '"other-1", "local-ws-100-2"' } });
      expect(listed.statusCode).toBe(304);

      const anyToken = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": "*" } });
      expect(anyToken.statusCode).toBe(304);

      state.body = "v2";
      state.etag = "local-ws-200-2";
      const changed = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": '"local-ws-100-2"' } });
      expect(changed.statusCode).toBe(200);
      expect(changed.body).toBe("v2");
      expect(changed.headers.etag).toBe('"local-ws-200-2"');
    } finally {
      await app.close();
    }
  });

  it("treats malformed etags (embedded quotes) as absent rather than matching", async () => {
    const state = { body: "v1", etag: 'bad"quote' };
    const { app } = await createApp(state);
    try {
      const first = await app.inject({ method: "GET", url: CONTENT_URL });
      expect(first.statusCode).toBe(200);
      expect(first.body).toBe("v1");
      // 畸形 etag 无法安全引用进响应头，按无版本标识处理：不回 etag、不参与 304
      expect(first.headers.etag).toBeUndefined();

      const second = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": '"bad\\"quote"' } });
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe("v1");
    } finally {
      await app.close();
    }
  });

  it("never answers 304 when the application provides no etag", async () => {
    const state = { body: "v1", etag: null };
    const { app } = await createApp(state);
    try {
      const first = await app.inject({ method: "GET", url: CONTENT_URL });
      expect(first.statusCode).toBe(200);
      expect(first.headers.etag).toBeUndefined();

      const second = await app.inject({ method: "GET", url: CONTENT_URL, headers: { "if-none-match": '"whatever"' } });
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe("v1");
    } finally {
      await app.close();
    }
  });

  it("rejects missing path and unknown sessions", async () => {
    const { app } = await createApp({ body: "v1", etag: "local-ws-100-2" });
    try {
      const noPath = await app.inject({ method: "GET", url: "/api/agent/sessions/ses_1/workspace-files/content" });
      expect(noPath.statusCode).toBe(400);

      const noSession = await app.inject({ method: "GET", url: "/api/agent/sessions/ses_missing/workspace-files/content?path=report.md" });
      expect(noSession.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

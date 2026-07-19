import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

const sessionSecret = "tenant-role-test-secret-at-least-32-characters";
const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(close.splice(0).map((dispose) => dispose()));
});

describe("管理中心租户角色权限", () => {
  it("member 只读和运行、admin 管配置、owner 执行高危操作", async () => {
    const harness = await buildTestHarness({
      sessionJwtSecret: sessionSecret,
      widgetJwtSecret: "widget-role-test-secret-at-least-32-characters",
    });
    close.push(() => harness.app.close());

    const installed = await harness.app.inject({
      method: "POST",
      url: "/api/install",
      payload: { deployment: "saas", tenancy: "multi", admin: { username: "owner", password: "password123" } },
    });
    expect(installed.statusCode).toBe(200);

    const ownerToken = await login(harness, "owner", "password123");
    await invite(harness, ownerToken, "member", "password456", "member");
    await invite(harness, ownerToken, "admin", "password789", "admin");
    const memberToken = await login(harness, "member", "password456");
    const adminToken = await login(harness, "admin", "password789");

    await expectStatus(harness, memberToken, "PATCH", "/api/system-config", 403, {});
    await expectStatus(harness, memberToken, "POST", "/api/agent/agents/create", 403, {});
    await expectStatus(harness, memberToken, "POST", "/api/knowledge-bases/index", 403, {});
    await expectStatus(harness, memberToken, "GET", "/api/model-adapter/provider-types", 200);
    await expectStatus(harness, memberToken, "GET", "/api/agent-config/configs", 200);
    await expectStatus(harness, memberToken, "GET", "/api/embedding-models/models", 200);
    await expectStatus(harness, memberToken, "GET", "/api/mcp/tools", 200);
    await expectStatus(harness, memberToken, "GET", "/api/skills", 200);
    await expectStatus(harness, memberToken, "GET", "/api/bots", 200);
    await expectStatus(harness, memberToken, "GET", "/api/agent/analytics/token-trend", 403);
    await expectStatus(harness, memberToken, "GET", "/api/agent/metrics", 403);
    await expectStatus(harness, memberToken, "GET", "/api/widget/apps", 403);

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/knowledge-bases/search",
      headers: bearer(memberToken),
      payload: { query: "hello", collection_name: "default" },
    });
    expect(search.statusCode).not.toBe(403);

    const execute = await harness.app.inject({
      method: "POST",
      url: "/api/agent/execute",
      headers: bearer(memberToken),
      payload: { task: "hello", session_id: "member-run" },
    });
    expect(execute.statusCode).not.toBe(403);

    await expectStatus(harness, adminToken, "POST", "/api/agent/agents/reload", 200, {});
    await expectStatus(harness, adminToken, "GET", "/api/bots", 200);
    await expectStatus(harness, adminToken, "GET", "/api/agent/analytics/token-trend", 200);
    await expectStatus(harness, adminToken, "GET", "/api/agent/metrics", 200);
    await expectStatus(harness, adminToken, "PATCH", "/api/system-config", 403, {});

    await expectStatus(harness, adminToken, "POST", "/api/model-adapter/providers", 200, {
      name: "Role Provider",
      provider_type: "deepseek",
      api_key: "sk-role-secret",
      model_map: { chat: "deepseek-chat" },
    });
    await expectStatus(harness, adminToken, "POST", "/api/mcp/servers", 200, {
      name: "role-server",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_TOKEN: "mcp-role-secret" },
      headers: { Authorization: "Bearer mcp-role-secret" },
      enabled: false,
      auto_connect: false,
    });
    const memberProviders = await harness.app.inject({
      method: "GET",
      url: "/api/model-adapter/providers",
      headers: bearer(memberToken),
    });
    expect(memberProviders.statusCode).toBe(200);
    expect(memberProviders.json().providers[0].api_key).toBe("********");
    const memberServers = await harness.app.inject({
      method: "GET",
      url: "/api/mcp/servers",
      headers: bearer(memberToken),
    });
    expect(memberServers.statusCode).toBe(200);
    expect(memberServers.json().data[0]).toMatchObject({
      env: { API_TOKEN: "********" },
      headers: { Authorization: "********" },
    });

    const createdApp = await harness.app.inject({
      method: "POST",
      url: "/api/widget/apps",
      headers: bearer(ownerToken),
      payload: { display_name: "Role test", allowed_origins: [] },
    });
    expect(createdApp.statusCode).toBe(200);
    const appKey = createdApp.json().app.app_key as string;
    await expectStatus(harness, adminToken, "POST", `/api/widget/apps/${appKey}/rotate-secret`, 403, {});

    await expectStatus(harness, ownerToken, "PATCH", "/api/system-config", 200, {});
    await expectStatus(harness, ownerToken, "POST", `/api/widget/apps/${appKey}/rotate-secret`, 200, {});
  });
});

async function invite(
  harness: Awaited<ReturnType<typeof buildTestHarness>>,
  ownerToken: string,
  username: string,
  password: string,
  role: "admin" | "member",
): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/tenants/tnt_default/members",
    headers: bearer(ownerToken),
    payload: { username, password, role },
  });
  expect(response.statusCode).toBe(200);
}

async function login(
  harness: Awaited<ReturnType<typeof buildTestHarness>>,
  username: string,
  password: string,
): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

async function expectStatus(
  harness: Awaited<ReturnType<typeof buildTestHarness>>,
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  statusCode: number,
  payload?: Record<string, unknown>,
): Promise<void> {
  const response = payload === undefined
    ? await harness.app.inject({ method, url, headers: bearer(token) })
    : await harness.app.inject({ method, url, headers: bearer(token), payload });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(statusCode);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

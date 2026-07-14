import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const feishuMock = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => Promise<void> | void>(),
  sent: [] as Array<{ chatId: string; receiveIdType: string; content: string }>,
  longStarts: 0,
  longCloses: 0,
}));

vi.mock("../../src/services/daemon/platforms/feishu-adapter.js", () => ({
  createFeishuClient: () => ({}),
  createDispatcher: (_connection: unknown, handlers: { onMessage(data: unknown): Promise<void> | void }) => {
    feishuMock.handlers.set("default", handlers.onMessage);
    return {
      invoke: async (body: unknown) => {
        await feishuMock.handlers.get("default")?.(body);
        return { code: 0 };
      },
    };
  },
  invokeWebhook: (dispatcher: { invoke(body: unknown): Promise<unknown> }, body: unknown) => dispatcher.invoke(body),
  sendTextMessage: async (_client: unknown, chatId: string, receiveIdType: string, content: string) => {
    feishuMock.sent.push({ chatId, receiveIdType, content });
    return { data: { message_id: "om_test" } };
  },
  startLongConnection: () => {
    feishuMock.longStarts += 1;
    return {
      started: Promise.resolve(),
      close: () => { feishuMock.longCloses += 1; },
    };
  },
}));

import { buildTestApp, buildTestHarness } from "../helpers/app.js";
import { DaemonSystemConfigSchema } from "../../src/contracts/daemon.js";
import { createTenantId } from "../../src/identity/types.js";
import { DaemonService } from "../../src/services/daemon/daemon-service.js";
import type { TenantRuntimeRegistry } from "../../src/services/runtime/tenant-runtime-registry.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  feishuMock.handlers.clear();
  feishuMock.sent.length = 0;
  feishuMock.longStarts = 0;
  feishuMock.longCloses = 0;
  if (app) await app.close();
  app = null;
});

describe("daemon 飞书接入", () => {
  it("保存配置后生成 routeToken 并脱敏凭证", async () => {
    app = await buildTestApp();
    const saved = await app.inject({ method: "PUT", url: "/api/daemon/config", payload: daemonConfig() });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ status: "ok", message: "配置已保存并生效" });

    const response = await app.inject({ method: "GET", url: "/api/daemon/config" });
    expect(response.statusCode).toBe(200);
    expect(response.json().agents[0].platforms.feishu).toMatchObject({
      app_id: "cli_demo",
      app_secret: "***",
      token: "***",
      encoding_aes_key: "***",
      route_token: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
  });

  it("webhook challenge 不依赖会话鉴权", async () => {
    app = await buildTestApp();
    await app.inject({ method: "PUT", url: "/api/daemon/config", payload: daemonConfig() });
    const config = await app.inject({ method: "GET", url: "/api/daemon/config" });
    const routeToken = config.json().agents[0].platforms.feishu.route_token as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/daemon/webhook/feishu/${routeToken}`,
      payload: { type: "url_verification", challenge: "challenge-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-value" });
  });

  it("收到飞书文本后执行注入的 agent 并回复原 chat", async () => {
    const daemon = new DaemonService({ configPath: "" });
    const tenantId = createTenantId("tnt_test");
    const routeIndex = new Map<string, { tenantId: typeof tenantId; teamName: string }>();
    const registry = {
      registerRouteToken: (id: typeof tenantId, teamName: string, routeToken: string) => routeIndex.set(routeToken, { tenantId: id, teamName }),
      unregisterRouteToken: (routeToken: string) => routeIndex.delete(routeToken),
      resolveRouteToken: (routeToken: string) => routeIndex.get(routeToken) ?? null,
      acquire: async () => ({ tenantId, runtime: { daemon }, release: () => undefined }),
    } as unknown as TenantRuntimeRegistry;
    const runAgentTask = vi.fn(async () => "agent reply");
    daemon.setRunAgentTask(runAgentTask);
    daemon.setRuntimeRegistry(registry, tenantId);
    daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig()));
    const routeToken = daemon.getConfig().agents[0]!.platforms.feishu!.route_token!;

    const response = await daemon.handleIncomingMessage(routeToken, {
      sender: { sender_id: { open_id: "ou_user" } },
      message: { chat_id: "oc_chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hello" }) },
    });

    expect(response).toEqual({ code: 0 });
    await vi.waitFor(() => {
      expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
        task: "hello",
        teamName: "default",
        entryAgent: "orchestrator_agent",
        sessionId: "daemon-default-feishu-oc_chat",
        source: "daemon.feishu.incoming",
      }));
    });
    await vi.waitFor(() => {
      expect(feishuMock.sent).toEqual([{ chatId: "ou_user", receiveIdType: "open_id", content: "agent reply" }]);
    });
    daemon.close();
  });

  it("相同 message_id 的重发消息只处理一次", async () => {
    const daemon = new DaemonService({ configPath: "" });
    const tenantId = createTenantId("tnt_test");
    const routeIndex = new Map<string, { tenantId: typeof tenantId; teamName: string }>();
    const registry = {
      registerRouteToken: (id: typeof tenantId, teamName: string, routeToken: string) => routeIndex.set(routeToken, { tenantId: id, teamName }),
      unregisterRouteToken: (routeToken: string) => routeIndex.delete(routeToken),
      resolveRouteToken: (routeToken: string) => routeIndex.get(routeToken) ?? null,
      acquire: async () => ({ tenantId, runtime: { daemon }, release: () => undefined }),
    } as unknown as TenantRuntimeRegistry;
    const runAgentTask = vi.fn(async () => "agent reply");
    daemon.setRunAgentTask(runAgentTask);
    daemon.setRuntimeRegistry(registry, tenantId);
    daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig()));
    const routeToken = daemon.getConfig().agents[0]!.platforms.feishu!.route_token!;

    const body = {
      sender: { sender_id: { open_id: "ou_user" } },
      message: { chat_id: "oc_chat", chat_type: "p2p", message_type: "text", message_id: "om_dup", content: JSON.stringify({ text: "hello" }) },
    };
    await daemon.handleIncomingMessage(routeToken, body);
    await daemon.handleIncomingMessage(routeToken, body);

    await vi.waitFor(() => {
      expect(runAgentTask).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(feishuMock.sent).toHaveLength(1);
    });
    daemon.close();
  });

  it("runtime-container 将 daemon 任务注入真实 agentExecution", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const execute = vi.spyOn(harness.container.agentExecution, "executeSynchronously").mockResolvedValue({
      success: true,
      answer: "runtime answer",
      agent_name: "orchestrator_agent",
      execution_time: 0,
      tool_calls: [],
      metadata: {},
      session_id: "daemon-default-feishu-test-chat",
      run_id: "run_test",
      task_id: "task_test",
      error: null,
    });
    harness.container.daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig()));

    const result = await harness.container.daemon.testMessage("default", { content: "run", platform: "feishu", chat_id: "test-chat" });

    expect(result.result).toBe("runtime answer");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      task: "run",
      session_id: "daemon-default-feishu-test-chat",
      agent: "orchestrator_agent",
      userId: "usr_daemon",
    }), expect.any(String));
  });

  it("长连接在配置重建和 daemon close 时正确启停", () => {
    const daemon = new DaemonService({ configPath: "" });
    daemon.setRunAgentTask(async () => "ok");

    daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig("long_connection")));
    expect(feishuMock.longStarts).toBe(1);
    expect(feishuMock.longCloses).toBe(0);

    daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig("long_connection")));
    expect(feishuMock.longStarts).toBe(2);
    expect(feishuMock.longCloses).toBe(1);

    daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig("webhook")));
    expect(feishuMock.longStarts).toBe(2);
    expect(feishuMock.longCloses).toBe(2);

    daemon.updateConfig(DaemonSystemConfigSchema.parse(daemonConfig("long_connection")));
    daemon.close();
    expect(feishuMock.longStarts).toBe(3);
    expect(feishuMock.longCloses).toBe(3);
  });

  it("receive_mode 默认使用长连接且不注册 webhook routeToken", () => {
    const daemon = new DaemonService({ configPath: "", runAgentTask: async () => "ok" });
    const tenantId = createTenantId("tnt_test");
    const routeIndex = new Map<string, { tenantId: typeof tenantId; teamName: string }>();
    const registry = {
      registerRouteToken: (id: typeof tenantId, teamName: string, routeToken: string) => routeIndex.set(routeToken, { tenantId: id, teamName }),
      unregisterRouteToken: (routeToken: string) => routeIndex.delete(routeToken),
      resolveRouteToken: (routeToken: string) => routeIndex.get(routeToken) ?? null,
    } as unknown as TenantRuntimeRegistry;
    daemon.setRuntimeRegistry(registry, tenantId);
    const config = daemonConfig();
    delete config.agents[0].platforms.feishu.receive_mode;
    daemon.updateConfig(DaemonSystemConfigSchema.parse(config));

    expect(daemon.getConfig().agents[0]!.platforms.feishu).toMatchObject({
      receive_mode: "long_connection",
      route_token: null,
    });
    expect(routeIndex.size).toBe(0);
    daemon.close();
  });

  it("旧 start/stop/status/agents 端点已移除", async () => {
    app = await buildTestApp();
    for (const [method, url] of [["POST", "/api/daemon/start"], ["POST", "/api/daemon/stop"], ["GET", "/api/daemon/status"], ["GET", "/api/daemon/agents"]] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
    }
  });
});

function daemonConfig(receiveMode: "webhook" | "long_connection" = "webhook") {
  return {
    enabled: true,
    default_session_ttl: 86400,
    agents: [{
      team_name: "default",
      entry_agent: "orchestrator_agent",
      session_id: null,
      permissions: {},
      enabled: true,
      platforms: {
        feishu: {
          enabled: true,
          app_id: "cli_demo",
          app_secret: "secret",
          token: "token",
          encoding_aes_key: "encrypt-key",
          route_token: null,
          receive_mode: receiveMode,
          webhook_url: null,
          session_id: null,
          extra: {},
        },
      },
      cron_tasks: [],
    }],
  };
}

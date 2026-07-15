import path from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const feishuMock = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => Promise<void> | void>(),
  sent: [] as Array<{ chatId: string; receiveIdType: string; content: string }>,
  longStarts: 0,
  longCloses: 0,
}));

vi.mock("../../src/services/daemon/platforms/feishu-adapter.js", () => ({
  createFeishuClient: () => ({}),
  createDispatcher: (_connection: unknown, handlers: { onMessage(data: unknown): Promise<void> | void }) => {
    const key = `handler-${feishuMock.handlers.size}`;
    feishuMock.handlers.set(key, handlers.onMessage);
    return {
      invoke: async (body: unknown) => {
        await handlers.onMessage(body);
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
    return { started: Promise.resolve(), close: () => { feishuMock.longCloses += 1; } };
  },
}));

import { createTenantId, createUserId, type RequestIdentity, type TenantId, type UserId } from "../../src/identity/types.js";
import { DaemonService, type DaemonRunAgentTask } from "../../src/services/daemon/daemon-service.js";
import type { IdentityProvider } from "../../src/services/identity/index.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import type { TenantRuntimeRegistry } from "../../src/services/runtime/tenant-runtime-registry.js";
import { createControlStore, type ControlStore } from "../../src/services/stores/control-store/index.js";
import { buildTestHarness } from "../helpers/app.js";
import { makeTempRoot } from "../helpers/temp-db.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
  feishuMock.handlers.clear();
  feishuMock.sent.length = 0;
  feishuMock.longStarts = 0;
  feishuMock.longCloses = 0;
});

describe("bot 自动化执行引擎", () => {
  it("Bot config CRUD 使用 control-store 并脱敏凭证", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const created = await app.inject({ method: "POST", url: "/api/bots", payload: { display_name: "Feishu Bot" } });
    expect(created.statusCode).toBe(200);
    const botId = created.json().bot.id as string;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/bots/${botId}/config`,
      payload: botConfigPatch("webhook"),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().feishu).toMatchObject({ app_secret: "***", token: "***", encoding_aes_key: "***", route_token: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(harness.controlStore.getBotRuntimeConfig(createUserId(botId))?.feishu.app_secret).toBe("secret");

    const maskedUpdate = await app.inject({
      method: "PUT",
      url: `/api/bots/${botId}/config`,
      payload: { feishu: { app_secret: "***", token: "***", encoding_aes_key: "***" } },
    });
    expect(maskedUpdate.statusCode).toBe(200);
    expect(harness.controlStore.getBotRuntimeConfig(createUserId(botId))?.feishu.app_secret).toBe("secret");
  });

  it("非 owner 无法读取或修改 bot 配置", async () => {
    const USER_A = createUserId("usr_owner_a");
    const USER_B = createUserId("usr_owner_b");
    const identityProvider: IdentityProvider = {
      resolve(request: FastifyRequest): RequestIdentity {
        return { userId: request.headers["x-test-user"] === "b" ? USER_B : USER_A, tenantId: LOCAL_TENANT_ID, role: "member", permissions: [] };
      },
    };
    const harness = await buildTestHarness({ identityProvider });
    app = harness.app;
    harness.controlStore.createTenant({ id: LOCAL_TENANT_ID, displayName: "Local" });
    for (const userId of [USER_A, USER_B]) {
      harness.controlStore.createUser({ id: userId, displayName: userId });
      harness.controlStore.upsertMembership({ userId, tenantId: LOCAL_TENANT_ID, role: "member" });
    }
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: USER_A, displayName: "Private Bot" });
    const tenantBots = await app.inject({ method: "GET", url: "/api/bots?tenant=1", headers: { "x-test-user": "b" } });
    expect(tenantBots.statusCode).toBe(200);
    expect(tenantBots.json().bots).toEqual([expect.objectContaining({ id: bot.id, ownerName: USER_A })]);
    expect(tenantBots.json().bots[0]).not.toHaveProperty("feishu");
    const privateList = await app.inject({ method: "GET", url: "/api/bots", headers: { "x-test-user": "b" } });
    expect(privateList.statusCode).toBe(200);
    expect(privateList.json().bots).toEqual([]);
    const denied = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/config`, headers: { "x-test-user": "b" } });
    expect(denied.statusCode).toBe(403);
    const updateDenied = await app.inject({ method: "PUT", url: `/api/bots/${bot.id}/config`, headers: { "x-test-user": "b" }, payload: { enabled: true } });
    expect(updateDenied.statusCode).toBe(403);
  });

  it("webhook routeToken 反查 bot 且无需鉴权", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Webhook Bot" });
    configureFeishu(harness.controlStore, bot.id, "webhook");
    app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    expect(harness.registry.resolveRouteToken(token)).toEqual({ tenantId: LOCAL_TENANT_ID, botId: bot.id });
    const response = await app.inject({ method: "POST", url: `/api/bots/webhook/feishu/${token}`, payload: { type: "url_verification", challenge: "ok" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "ok" });
  });

  it("收到飞书消息后以 bot 身份执行并写 sender metadata", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Runner Bot" });
    configureFeishu(harness.controlStore, bot.id, "webhook");
    const execute = vi.spyOn(harness.container.agentExecution, "executeSynchronously").mockImplementation(async (request) => {
      harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: request.session_id!, userId: request.userId });
      return { success: true, answer: "reply", agent_name: "orchestrator_agent", execution_time: 0, tool_calls: [], metadata: {}, session_id: request.session_id!, run_id: "run", task_id: "task", error: null };
    });
    app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    await app.botEngine.handleIncomingMessage(token, feishuMessage("om_runtime"));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      userId: bot.id,
      executionKind: "daemon.feishu.incoming",
    }), expect.any(String)));
    const sessionId = `bot-${bot.id}-feishu-oc_chat`;
    await vi.waitFor(() => expect(harness.container.sessionApplication.getSession(sessionId)?.permission_mode).toBe("relaxed"));
    await vi.waitFor(() => expect(harness.container.sessionApplication.getSession(sessionId)?.metadata).toMatchObject({ feishu: { sender_open_id: "ou_user" } }));
    await vi.waitFor(() => expect(feishuMock.sent).toEqual([{ chatId: "ou_user", receiveIdType: "open_id", content: "reply" }]));
  });

  it("bot 只在新建会话时继承 permission_mode，不覆盖已有会话", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Policy Bot" });
    configureFeishu(harness.controlStore, bot.id, "webhook");
    harness.controlStore.updateBotConfig(bot.id, { permission_mode: "dangerously_skip_permissions" });
    const sessionId = `bot-${bot.id}-feishu-oc_chat`;
    harness.container.conversationStore.createSession(LOCAL_TENANT_ID, sessionId, bot.id, {}, "standard");
    const execute = vi.spyOn(harness.container.agentExecution, "executeSynchronously").mockResolvedValue({
      success: true,
      answer: "reply",
      agent_name: "orchestrator_agent",
      execution_time: 0,
      tool_calls: [],
      metadata: {},
      session_id: sessionId,
      run_id: "run",
      task_id: "task",
      error: null,
    });
    app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    await app.botEngine.handleIncomingMessage(token, feishuMessage("om_existing_policy"));
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.container.conversationStore.getSession(sessionId)?.permission_mode).toBe("standard"));
  });

  it("reloadBot 在 bot 禁用时卸载长连接，恢复后重建", () => {
    const harness = createEngineHarness(async () => "ok");
    configureFeishu(harness.controlStore, harness.botId, "long_connection");
    harness.engine.reloadBot(harness.botId);
    expect(feishuMock.longStarts).toBe(1);
    harness.controlStore.setUserStatus(harness.botId, "disabled");
    harness.engine.reloadBot(harness.botId);
    expect(feishuMock.longCloses).toBe(1);
    expect(feishuMock.longStarts).toBe(1);
    expect(() => harness.engine.listBotCronTasks(harness.botId)).toThrow("bot 已禁用");
    harness.controlStore.setUserStatus(harness.botId, "active");
    harness.engine.reloadBot(harness.botId);
    expect(feishuMock.longStarts).toBe(2);
    harness.close();
  });

  it("reloadBot 在 bot 禁用时注销 routeToken，恢复后重新注册", () => {
    const harness = createEngineHarness(async () => "ok");
    configureFeishu(harness.controlStore, harness.botId, "webhook");
    harness.engine.reloadBot(harness.botId);
    const routeToken = harness.controlStore.getBotRuntimeConfig(harness.botId)!.feishu.route_token!;
    expect(harness.registry.resolveRouteToken(routeToken)).toEqual({ tenantId: harness.tenantId, botId: harness.botId });
    harness.controlStore.setUserStatus(harness.botId, "disabled");
    harness.engine.reloadBot(harness.botId);
    expect(harness.registry.resolveRouteToken(routeToken)).toBeNull();
    harness.controlStore.setUserStatus(harness.botId, "active");
    harness.engine.reloadBot(harness.botId);
    expect(harness.registry.resolveRouteToken(routeToken)).toEqual({ tenantId: harness.tenantId, botId: harness.botId });
    harness.close();
  });

  it("长连接不随 tenant runtime idle 回收", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Persistent Bot" });
    configureFeishu(harness.controlStore, bot.id, "long_connection");
    app.botEngine.reloadBot(bot.id);
    expect(feishuMock.longStarts).toBe(1);
    await harness.registry.closeTenant(LOCAL_TENANT_ID);
    expect(feishuMock.longCloses).toBe(0);
  });

  it("bot Cron CRUD 落 control-store 并以 botId trigger", async () => {
    const runAgentTask = vi.fn(async () => "cron result");
    const harness = createEngineHarness(runAgentTask);
    const created = harness.engine.createBotCronTask(harness.botId, {
      task_id: "daily",
      cron: "0 9 * * *",
      task: "daily report",
      entry_agent: null,
      enabled: true,
      push_platform: null,
      push_chat_id: null,
    });
    expect(harness.controlStore.getBotCronTask(harness.botId, "daily")).toEqual(created);
    expect(created.next_run).not.toBeNull();
    const triggered = await harness.engine.triggerBotCronTask(harness.botId, "daily");
    expect(triggered.result).toBe("cron result");
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ botId: harness.botId, task: "daily report", source: "daemon.cron" }));
    expect(harness.controlStore.getBotCronTask(harness.botId, "daily")?.last_result).toBe("cron result");
    expect(harness.engine.deleteBotCronTask(harness.botId, "daily")).toBe(true);
    expect(harness.controlStore.getBotCronTask(harness.botId, "daily")).toBeNull();
    harness.close();
  });

  it("自动调度只串行触发 active bot 已启用且到期的任务", async () => {
    const executionOrder: string[] = [];
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const runAgentTask = vi.fn(async ({ task }: { task: string }) => {
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      executionOrder.push(task);
      await Promise.resolve();
      activeExecutions -= 1;
      return `result:${task}`;
    });
    const harness = createEngineHarness(runAgentTask);
    const now = 1_700_000_000;
    for (const [taskId, enabled, nextRun] of [
      ["due-a", true, now - 2],
      ["due-b", true, now - 1],
      ["future", true, now + 60],
      ["disabled", false, now - 1],
    ] as const) {
      harness.controlStore.createBotCronTask(harness.botId, {
        task_id: taskId,
        cron: "* * * * *",
        task: taskId,
        entry_agent: null,
        enabled,
        push_platform: null,
        push_chat_id: null,
        next_run: nextRun,
      });
    }

    await runDueTasks(harness.engine, now);

    expect(executionOrder).toEqual(["due-a", "due-b"]);
    expect(maxActiveExecutions).toBe(1);
    expect(harness.controlStore.getBotCronTask(harness.botId, "due-a")?.next_run).toBeGreaterThan(now);
    expect(harness.controlStore.getBotCronTask(harness.botId, "future")?.last_run).toBeNull();
    expect(harness.controlStore.getBotCronTask(harness.botId, "disabled")?.last_run).toBeNull();

    harness.controlStore.updateBotCronTask(harness.botId, "future", { next_run: now - 1 });
    harness.controlStore.setUserStatus(harness.botId, "disabled");
    await runDueTasks(harness.engine, now);
    expect(executionOrder).toEqual(["due-a", "due-b"]);
    harness.close();
  });

  it("自动调度隔离单任务失败并继续推进后续任务", async () => {
    const runAgentTask = vi.fn(async ({ task }: { task: string }) => {
      if (task === "fail") throw new Error("scheduled failure");
      return "ok";
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createEngineHarness(runAgentTask);
    const now = 1_700_000_000;
    for (const taskId of ["a-fail", "b-ok"]) {
      harness.controlStore.createBotCronTask(harness.botId, {
        task_id: taskId,
        cron: "* * * * *",
        task: taskId === "a-fail" ? "fail" : "ok",
        entry_agent: null,
        enabled: true,
        push_platform: null,
        push_chat_id: null,
        next_run: now - 1,
      });
    }

    await runDueTasks(harness.engine, now);

    expect(runAgentTask).toHaveBeenCalledTimes(2);
    expect(harness.controlStore.getBotCronTask(harness.botId, "a-fail")?.last_result).toContain("scheduled failure");
    expect(harness.controlStore.getBotCronTask(harness.botId, "a-fail")?.next_run).toBeGreaterThan(now);
    expect(harness.controlStore.getBotCronTask(harness.botId, "b-ok")?.last_result).toBe("ok");
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
    harness.close();
  });

  it("start 遍历 control-store 中已启用飞书 bot", () => {
    const harness = createEngineHarness(async () => "ok", false);
    configureFeishu(harness.controlStore, harness.botId, "long_connection");
    harness.engine.start();
    expect(feishuMock.longStarts).toBe(1);
    harness.close();
  });
});

function createEngineHarness(runAgentTask: DaemonRunAgentTask, start = true) {
  const root = makeTempRoot();
  const controlStore = createControlStore(path.join(root, "system"));
  const tenantId = createTenantId("tnt_test");
  const ownerId = createUserId("usr_owner");
  controlStore.createTenant({ id: tenantId, displayName: "Test" });
  controlStore.createUser({ id: ownerId, displayName: "Owner" });
  controlStore.upsertMembership({ userId: ownerId, tenantId, role: "owner" });
  const botId = controlStore.createBot({ tenantId, ownerId, displayName: "Bot" }).id;
  const routeIndex = new Map<string, { tenantId: TenantId; botId: UserId }>();
  const registry = {
    registerRouteToken: (id: TenantId, idBot: UserId, routeToken: string) => routeIndex.set(routeToken, { tenantId: id, botId: idBot }),
    unregisterRouteToken: (routeToken: string) => routeIndex.delete(routeToken),
    resolveRouteToken: (routeToken: string) => routeIndex.get(routeToken) ?? null,
  } as unknown as TenantRuntimeRegistry;
  const engine = new DaemonService({ controlStore, registry, runAgentTask });
  if (start) engine.start();
  return { tenantId, botId, controlStore, engine, registry, close: () => { engine.close(); controlStore.close(); } };
}

function runDueTasks(engine: DaemonService, now: number): Promise<void> {
  return (engine as unknown as { runDueTasks(timestamp: number): Promise<void> }).runDueTasks(now);
}

function configureFeishu(controlStore: ControlStore, botId: UserId, receiveMode: "webhook" | "long_connection"): void {
  controlStore.updateBotConfig(botId, {
    enabled: true,
    entry_agent: "orchestrator_agent",
    feishu: {
      enabled: true,
      app_id: "cli_demo",
      app_secret: "secret",
      token: "token",
      encoding_aes_key: "encrypt-key",
      receive_mode: receiveMode,
    },
  });
}

function botConfigPatch(receiveMode: "webhook" | "long_connection") {
  return {
    enabled: true,
    entry_agent: "orchestrator_agent",
    session_id: null,
    default_session_ttl: 86400,
    feishu: { enabled: true, app_id: "cli_demo", app_secret: "secret", token: "token", encoding_aes_key: "encrypt-key", receive_mode: receiveMode },
  };
}

function feishuMessage(messageId: string) {
  return {
    sender: { sender_id: { open_id: "ou_user" } },
    message: { chat_id: "oc_chat", chat_type: "p2p", message_type: "text", message_id: messageId, content: JSON.stringify({ text: "hello" }) },
  };
}

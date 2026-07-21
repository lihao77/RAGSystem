import path from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRealtimeHistory } from "../helpers/realtime.js";

const feishuMock = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => Promise<void> | void>(),
  sent: [] as Array<{ chatId: string; receiveIdType: string; content: string }>,
  cards: [] as Array<{ chatId: string; cardSchema: Record<string, unknown> }>,
  longStarts: 0,
  longCloses: 0,
}));

vi.mock("../../src/services/daemon/platforms/feishu-adapter.js", () => ({
  createFeishuClient: () => ({}),
  createDispatcher: (_connection: unknown, handlers: { onMessage(data: unknown): Promise<void> | void; onCardAction(data: unknown): Promise<unknown> | unknown }) => {
    const key = `handler-${feishuMock.handlers.size}`;
    feishuMock.handlers.set(key, handlers.onMessage);
    return {
      invoke: async (body: unknown) => {
        const record = body as { action?: unknown };
        return record.action ? handlers.onCardAction(body) : handlers.onMessage(body);
      },
    };
  },
  invokeWebhook: (dispatcher: { invoke(body: unknown): Promise<unknown> }, body: unknown) => dispatcher.invoke(body),
  sendTextMessage: async (_client: unknown, chatId: string, receiveIdType: string, content: string) => {
    feishuMock.sent.push({ chatId, receiveIdType, content });
    return { data: { message_id: "om_test" } };
  },
  sendInteractiveCard: async (_client: unknown, input: { chatId: string; cardSchema: Record<string, unknown> }) => {
    feishuMock.cards.push(input);
    return { data: { message_id: "om_card" } };
  },
  buildApprovalCard: (input: Record<string, unknown>) => ({ kind: "approval-card", input }),
  buildUserInputCard: (input: Record<string, unknown>) => ({ kind: "input-card", input }),
  startLongConnection: () => {
    feishuMock.longStarts += 1;
    return { started: Promise.resolve(), close: () => { feishuMock.longCloses += 1; } };
  },
}));

import { createTenantId, createUserId, type RequestIdentity, type TenantId, type UserId } from "../../src/identity/types.js";
import { DaemonService, resolveBotChatId, type DaemonRunAgentTask } from "../../src/services/daemon/daemon-service.js";
import type { IdentityProvider } from "../../src/services/identity/index.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import type { TenantRuntimeRegistry } from "../../src/adapters/local/tenant-runtime-registry.js";
import { createControlStore, type ControlStore } from "../../src/adapters/local/sqlite/control-store/index.js";
import { SqliteBotRepository } from "../../src/adapters/local/sqlite/sqlite-bot-repository.js";
import { buildTestHarness } from "../helpers/app.js";
import { makeTempRoot } from "../helpers/temp-db.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
  feishuMock.handlers.clear();
  feishuMock.sent.length = 0;
  feishuMock.cards.length = 0;
  feishuMock.longStarts = 0;
  feishuMock.longCloses = 0;
});

describe("bot 自动化执行引擎", () => {
  it("chat_id 按会话、sender、默认配置、cron 推送顺序解析", () => {
    const config = {
      feishu: { default_chat_id: "oc_default" },
    } as unknown as Parameters<typeof resolveBotChatId>[0];
    expect(resolveBotChatId(config, { chatId: "oc_session", sender_open_id: "ou_sender" }, { push_chat_id: "oc_cron" })).toBe("oc_session");
    expect(resolveBotChatId(config, { sender_open_id: "ou_sender" }, { push_chat_id: "oc_cron" })).toBe("ou_sender");
    expect(resolveBotChatId(config, {}, { push_chat_id: "oc_cron" })).toBe("oc_default");
    expect(resolveBotChatId({ feishu: { default_chat_id: null } } as unknown as Parameters<typeof resolveBotChatId>[0], {}, { push_chat_id: "oc_cron" })).toBe("oc_cron");
  });

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
    expect(updated.json().feishu).toMatchObject({ app_secret: "***", token: "***", encoding_aes_key: "***", route_token: expect.stringMatching(/^[a-f0-9]{32}$/), default_chat_id: "oc_default" });
    expect(harness.controlStore.getBotRuntimeConfig(createUserId(botId))?.feishu.app_secret).toBe("secret");
    expect(harness.controlStore.getBotRuntimeConfig(createUserId(botId))?.feishu.default_chat_id).toBe("oc_default");

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
      async resolve(request: FastifyRequest): Promise<RequestIdentity> {
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
    await app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    await expect(new SqliteBotRepository(harness.controlStore).resolveWebhookTarget(token))
      .resolves.toEqual({ tenantId: LOCAL_TENANT_ID, botId: bot.id });
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
      await harness.container.sessionApplication.createSession({ sessionId: request.session_id!, userId: request.userId });
      return { success: true, answer: "reply", agent_name: "orchestrator_agent", execution_time: 0, tool_calls: [], metadata: {}, session_id: request.session_id!, run_id: "run", task_id: "task", error: null };
    });
    await app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    await app.botEngine.handleIncomingMessage(token, feishuMessage("om_runtime"));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      userId: bot.id,
      executionKind: "daemon.feishu.incoming",
    }), expect.any(String)));
    const sessionId = `bot-${bot.id}-feishu-oc_chat`;
    await vi.waitFor(async () => expect((await harness.container.sessionApplication.getSession(sessionId))?.permission_mode).toBe("relaxed"));
    await vi.waitFor(async () => expect((await harness.container.sessionApplication.getSession(sessionId))?.metadata).toMatchObject({ feishu: { sender_open_id: "ou_user" } }));
    await vi.waitFor(() => expect(feishuMock.sent).toEqual([{ chatId: "ou_user", receiveIdType: "open_id", content: "reply" }]));
  });

  it("忽略飞书机器人自身发出的消息事件", async () => {
    const harness = await createEngineHarness(vi.fn(async () => completed("reply")));
    configureFeishu(harness.controlStore, harness.botId, "webhook");
    await harness.engine.reloadBot(harness.botId);
    const token = harness.controlStore.getBotRuntimeConfig(harness.botId)!.feishu.route_token!;

    await harness.engine.handleIncomingMessage(token, {
      ...feishuMessage("om_bot_echo"),
      sender: { sender_type: "ASSISTANT", sender_id: { open_id: "ou_bot" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feishuMock.sent).toEqual([]);
    harness.close();
  });

  it("app runAgentTask 将 suspended 作为第三态返回并由 daemon 发卡片", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Suspended Bot" });
    configureFeishu(harness.controlStore, bot.id, "webhook");
    const execute = vi.spyOn(harness.container.agentExecution, "executeSynchronously").mockImplementation(async (request) => {
      const sessionId = request.session_id!;
      await harness.container.sessionApplication.createSession({ sessionId, userId: request.userId });
      harness.container.local.conversationStore.createRun({ runId: "root-suspended", sessionId, agentName: "orchestrator_agent" });
      const pending = harness.container.pendingInteractions.waitForApproval({
        sessionId,
        runId: "root-suspended",
        rootRunId: "root-suspended",
        parentRunId: null,
        parentCallId: null,
        toolCallId: "tool-suspended",
        deadlineMs: 0,
        task: request.task,
        executionKind: request.executionKind,
        toolName: "execute_bash",
        riskLevel: "high",
        approvalReason: "高风险工具需要审批",
        onInteractionRequired: request.onInteractionRequired,
      });
      await pending.catch(() => undefined);
      return {
        success: false,
        suspended: true,
        rootRunId: "root-suspended",
        answer: null,
        agent_name: "orchestrator_agent",
        execution_time: 0,
        tool_calls: [],
        metadata: {},
        session_id: sessionId,
        run_id: "root-suspended",
        task_id: "task-suspended",
        error: "任务已挂起",
      };
    });
    await app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;

    await app.botEngine.handleIncomingMessage(token, feishuMessage("om_suspended"));

    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await vi.waitFor(() => expect(feishuMock.cards).toEqual([{
      chatId: "oc_chat",
      cardSchema: expect.objectContaining({ kind: "approval-card" }),
    }]));
    expect(feishuMock.sent).toEqual([]);
  });

  it("card.action 响应挂起审批并从原 rootRunId 恢复", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Approval Bot" });
    configureFeishu(harness.controlStore, bot.id, "webhook");
    await app.botEngine.reloadBot(bot.id);
    const sessionId = "feishu-card-session";
    harness.container.local.conversationStore.createSession(LOCAL_TENANT_ID, sessionId, bot.id, { chatId: "oc_resume" });
    harness.container.local.conversationStore.createRun({ runId: "root-run", sessionId, agentName: "orchestrator_agent", status: "suspended" });
    const suspended = harness.container.pendingInteractions.waitForApproval({
      sessionId,
      runId: "root-run",
      rootRunId: "root-run",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-call",
      deadlineMs: 0,
      task: "执行任务",
      toolName: "execute_bash",
    });
    await expect(suspended).rejects.toBeDefined();
    await vi.waitFor(() => expect(getRealtimeHistory(harness.container.realtimeEvents, sessionId).at(-1)).toBeDefined());
    const approvalId = getRealtimeHistory(harness.container.realtimeEvents, sessionId).at(-1)?.call_id ?? "";
    const startClaim = vi.fn().mockReturnValue({
      promise: Promise.resolve({ content: "恢复完成", success: true }),
    });
    harness.container.interactionCoordinator.bindResumeStarter({ startClaim });

    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    const response = await app.botEngine.handleIncomingMessage(token, {
      action: {
        tag: "button",
        value: { kind: "approval", approvalId, sessionId, botId: bot.id, decision: "approve" },
      },
    });

    expect(response).toEqual({ toast: { type: "success", content: "已恢复 Agent 执行" } });
    expect(startClaim).toHaveBeenCalled();
    await vi.waitFor(() => expect(feishuMock.sent).toContainEqual({ chatId: "oc_resume", receiveIdType: "chat_id", content: "恢复完成" }));
  });

  it("bot 只在新建会话时继承 permission_mode，不覆盖已有会话", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Policy Bot" });
    configureFeishu(harness.controlStore, bot.id, "webhook");
    harness.controlStore.updateBotConfig(bot.id, { permission_mode: "dangerously_skip_permissions" });
    const sessionId = `bot-${bot.id}-feishu-oc_chat`;
    harness.container.local.conversationStore.createSession(LOCAL_TENANT_ID, sessionId, bot.id, {}, "standard");
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
    await app.botEngine.reloadBot(bot.id);
    const token = harness.controlStore.getBotRuntimeConfig(bot.id)!.feishu.route_token!;
    await app.botEngine.handleIncomingMessage(token, feishuMessage("om_existing_policy"));
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.container.local.conversationStore.getSession(sessionId)?.permission_mode).toBe("standard"));
  });

  it("reloadBot 在 bot 禁用时卸载长连接，恢复后重建", async () => {
    const harness = await createEngineHarness(async () => completed("ok"));
    configureFeishu(harness.controlStore, harness.botId, "long_connection");
    await harness.engine.reloadBot(harness.botId);
    expect(feishuMock.longStarts).toBe(1);
    harness.controlStore.setUserStatus(harness.botId, "disabled");
    await harness.engine.reloadBot(harness.botId);
    expect(feishuMock.longCloses).toBe(1);
    expect(feishuMock.longStarts).toBe(1);
    await expect(harness.engine.listBotCronTasks(harness.botId)).rejects.toThrow("bot 已禁用");
    harness.controlStore.setUserStatus(harness.botId, "active");
    await harness.engine.reloadBot(harness.botId);
    expect(feishuMock.longStarts).toBe(2);
    harness.close();
  });

  it("repository 仅解析启用 bot 的 routeToken", async () => {
    const harness = await createEngineHarness(async () => completed("ok"));
    configureFeishu(harness.controlStore, harness.botId, "webhook");
    await harness.engine.reloadBot(harness.botId);
    const routeToken = harness.controlStore.getBotRuntimeConfig(harness.botId)!.feishu.route_token!;
    await expect(harness.botRepository.resolveWebhookTarget(routeToken)).resolves.toEqual({ tenantId: harness.tenantId, botId: harness.botId });
    harness.controlStore.setUserStatus(harness.botId, "disabled");
    await harness.engine.reloadBot(harness.botId);
    await expect(harness.botRepository.resolveWebhookTarget(routeToken)).resolves.toBeNull();
    harness.controlStore.setUserStatus(harness.botId, "active");
    await harness.engine.reloadBot(harness.botId);
    await expect(harness.botRepository.resolveWebhookTarget(routeToken)).resolves.toEqual({ tenantId: harness.tenantId, botId: harness.botId });
    harness.close();
  });

  it("并发 reloadBot 只保留一个飞书 runtime", async () => {
    const harness = await createEngineHarness(async () => completed("ok"), false);
    configureFeishu(harness.controlStore, harness.botId, "long_connection");
    await Promise.all([
      harness.engine.reloadBot(harness.botId),
      harness.engine.reloadBot(harness.botId),
    ]);
    expect(feishuMock.longStarts).toBe(2);
    expect(feishuMock.longCloses).toBe(1);
    harness.close();
    expect(feishuMock.longCloses).toBe(2);
  });

  it("长连接不随 tenant runtime idle 回收", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const bot = harness.controlStore.createBot({ tenantId: LOCAL_TENANT_ID, ownerId: LOCAL_USER_ID, displayName: "Persistent Bot" });
    configureFeishu(harness.controlStore, bot.id, "long_connection");
    await app.botEngine.reloadBot(bot.id);
    expect(feishuMock.longStarts).toBe(1);
    await harness.registry.closeTenant(LOCAL_TENANT_ID);
    expect(feishuMock.longCloses).toBe(0);
  });

  it("bot Cron CRUD 落 control-store 并以 botId trigger", async () => {
    const runAgentTask = vi.fn(async () => completed("cron result"));
    const harness = await createEngineHarness(runAgentTask);
    const created = await harness.engine.createBotCronTask(harness.botId, {
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
    await expect(harness.engine.deleteBotCronTask(harness.botId, "daily")).resolves.toBe(true);
    expect(harness.controlStore.getBotCronTask(harness.botId, "daily")).toBeNull();
    harness.close();
  });

  it("daemon run 挂起时向 default_chat_id 发送审批卡片且不抛错重试", async () => {
    const harness = await createEngineHarness(async (input) => ({
      suspended: true,
      content: "",
      interaction: {
        approvalId: "approval-cron",
        sessionId: input.sessionId,
        botId: input.botId,
        rootRunId: "root-run",
        kind: "approval",
        toolName: "execute_bash",
        riskLevel: "high",
        reason: "需要审批",
      },
    }));
    configureFeishu(harness.controlStore, harness.botId, "webhook");
    harness.controlStore.updateBotConfig(harness.botId, { feishu: { default_chat_id: "oc_default" } });
    await harness.engine.reloadBot(harness.botId);
    harness.controlStore.createBotCronTask(harness.botId, {
      task_id: "suspended",
      cron: "* * * * *",
      task: "执行高风险任务",
      entry_agent: null,
      enabled: true,
      push_platform: null,
      push_chat_id: "oc_cron",
      next_run: null,
    });

    await expect(harness.engine.triggerBotCronTask(harness.botId, "suspended")).resolves.toEqual({ status: "ok", result: null });
    expect(feishuMock.cards).toEqual([{
      chatId: "oc_default",
      cardSchema: expect.objectContaining({ kind: "approval-card" }),
    }]);
    expect(harness.controlStore.getBotCronTask(harness.botId, "suspended")?.last_result).toBe("SUSPENDED");
    harness.close();
  });

  it("daemon 同批多审批一次发送全部卡片", async () => {
    const harness = await createEngineHarness(async (input) => {
      const interactions = ["approval-1", "approval-2"].map((approvalId, index) => ({
        approvalId,
        sessionId: input.sessionId,
        botId: input.botId,
        rootRunId: "root-run",
        kind: "approval" as const,
        toolName: index === 0 ? "write_file" : "execute_bash",
        riskLevel: "high",
        reason: "需要审批",
      }));
      return { suspended: true as const, content: "" as const, interaction: interactions[0]!, interactions };
    });
    configureFeishu(harness.controlStore, harness.botId, "webhook");
    harness.controlStore.updateBotConfig(harness.botId, { feishu: { default_chat_id: "oc_batch" } });
    await harness.engine.reloadBot(harness.botId);

    await harness.engine.testMessage(harness.botId, { platform: "feishu", chat_id: "oc_batch", content: "批量审批" });

    expect(feishuMock.cards).toHaveLength(2);
    expect(feishuMock.cards.map((item) => (item.cardSchema.input as { approvalId?: string }).approvalId)).toEqual([
      "approval-1",
      "approval-2",
    ]);
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
      return completed(`result:${task}`);
    });
    const harness = await createEngineHarness(runAgentTask);
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
      return completed("ok");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await createEngineHarness(runAgentTask);
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

  it("start 遍历 control-store 中已启用飞书 bot", async () => {
    const harness = await createEngineHarness(async () => completed("ok"), false);
    configureFeishu(harness.controlStore, harness.botId, "long_connection");
    await harness.engine.start();
    expect(feishuMock.longStarts).toBe(1);
    harness.close();
  });
});

async function createEngineHarness(runAgentTask: DaemonRunAgentTask, start = true) {
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
  const botRepository = new SqliteBotRepository(controlStore);
  const engine = new DaemonService({ botRepository, registry, runAgentTask });
  if (start) await engine.start();
  return { tenantId, botId, controlStore, botRepository, engine, registry, close: () => { engine.close(); controlStore.close(); } };
}

function completed(content: string) {
  return { suspended: false as const, content };
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
    feishu: { enabled: true, app_id: "cli_demo", app_secret: "secret", token: "token", encoding_aes_key: "encrypt-key", receive_mode: receiveMode, default_chat_id: "oc_default" },
  };
}

function feishuMessage(messageId: string) {
  return {
    sender: { sender_id: { open_id: "ou_user" } },
    message: { chat_id: "oc_chat", chat_type: "p2p", message_type: "text", message_id: messageId, content: JSON.stringify({ text: "hello" }) },
  };
}

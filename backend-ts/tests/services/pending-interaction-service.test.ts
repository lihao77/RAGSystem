import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RecoverableInterrupt } from "@ragsystem/agent-protocol";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import { resolveInteractionDeadlineMs } from "../../src/services/runtime/pending-interaction-service.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";

describe("PendingInteractionService", () => {
  it("daemon 与交互入口统一等待两分钟", () => {
    expect(resolveInteractionDeadlineMs("daemon")).toBe(120_000);
    expect(resolveInteractionDeadlineMs("daemon.cron")).toBe(120_000);
    expect(resolveInteractionDeadlineMs("daemon.webhook")).toBe(120_000);
    expect(resolveInteractionDeadlineMs("agent_stream")).toBe(120_000);
  });

  it("resolves approval interactions through the generic interaction response path", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const clientEvents = new DurableClientEventPublisher(store, dispatcher);
    const service = new PendingInteractionService(clientEvents);
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");

    const onInteractionRequired = vi.fn();
    const approvalPromise = service.waitForApproval({
      sessionId: "s1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      taskId: "task-1",
      requestId: "req-1",
      toolCallId: "tool-call-1",
      deadlineMs: 120_000,
      task: "执行命令",
      toolName: "execute_bash",
      arguments: { command: "echo ok" },
      riskLevel: "high",
      description: "Execute bash command",
      onInteractionRequired,
      permissionMode: "standard",
      approvalReason: "标准模式：high 风险工具需要审批",
      approvalReasonCodes: ["ask-risk"],
    });
    expect(onInteractionRequired).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      rootRunId: "run-1",
      kind: "approval",
    }));

    const history = realtimeEvents.getHistory("s1");
    const approvalRequired = history.find(
      (event) =>
        event.type === "interaction" &&
        (event.payload as { kind?: string; phase?: string }).kind === "approval" &&
        (event.payload as { phase?: string }).phase === "required",
    );
    // 新协议：interaction.required + user.approval_required 合并为单条 interaction(approval, required)。
    expect(history.map((event) => event.seq)).toEqual([1]);
    expect(
      store.listOutboxForReplay({ sessionId: "s1" }).map((row) => ({
        eventType: row.event_type,
        status: row.status,
        sessionSeq: row.session_seq,
      })),
    ).toEqual([
      { eventType: "client.interaction", status: "delivered", sessionSeq: 1 },
    ]);
    expect(approvalRequired).toMatchObject({
      call_id: expect.any(String),
      run_id: "run-1",
      payload: {
        kind: "approval",
        phase: "required",
        tool: "execute_bash",
        risk_level: "high",
        prompt: "Execute bash command",
        input: {
          approval_id: expect.any(String),
          approval_type: null,
          tool_call_id: "tool-call-1",
          agent_name: null,
          arguments: { command: "echo ok" },
          permission_mode: "standard",
          approval_reason: "标准模式：high 风险工具需要审批",
          approval_reason_codes: ["ask-risk"],
          approval_secondary_reasons: [],
          approval_hook: {},
          external_path_candidates: [],
        },
        message: "标准模式：high 风险工具需要审批",
      },
    });

    const approvalId = approvalRequired?.call_id as string;
    expect(service.isApprovalPending("s1", approvalId)).toBe(true);
    expect(
      service.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许执行",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
      interactionId: approvalId,
      approved: true,
      message: "允许执行",
    });

    await expect(approvalPromise).resolves.toMatchObject({
      approvalId,
      approved: true,
      message: "允许执行",
    });
    expect(service.isApprovalPending("s1", approvalId)).toBe(false);
    const resolvedHistory = realtimeEvents.getHistory("s1");
    const approvalResolved = resolvedHistory.find(
      (event) =>
        event.type === "interaction" &&
        (event.payload as { kind?: string; phase?: string }).kind === "approval" &&
        (event.payload as { phase?: string }).phase === "responded",
    );
    expect(resolvedHistory.map((event) => event.seq)).toEqual([1, 2]);
    expect(approvalResolved).toMatchObject({
      seq: 2,
      run_id: "run-1",
      call_id: approvalId,
      payload: {
        kind: "approval",
        phase: "responded",
        approved: true,
        message: "允许执行",
      },
    });
    expect(
      store.listOutboxForReplay({ sessionId: "s1" }).map((row) => ({
        eventType: row.event_type,
        status: row.status,
        sessionSeq: row.session_seq,
      })),
    ).toEqual([
      { eventType: "client.interaction", status: "delivered", sessionSeq: 1 },
      { eventType: "client.interaction", status: "delivered", sessionSeq: 2 },
    ]);
    store.close();
  });

  it("超时挂起后返回恢复凭证并缓存审批结果", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const service = new PendingInteractionService(new DurableClientEventPublisher(store, dispatcher));
    store.createSession(LOCAL_TENANT_ID, "s-resume", "usr_local");

    const suspended = service.waitForApproval({
      sessionId: "s-resume",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "call-agent-1",
      toolCallId: "tool-resume",
      deadlineMs: 0,
      task: "完整根任务",
      executionKind: "daemon.cron",
      toolName: "execute_bash",
    });
    const approvalId = realtimeEvents.getHistory("s-resume")[0]?.call_id ?? "";
    await expect(suspended).rejects.toBeInstanceOf(RecoverableInterrupt);

    expect(service.respondApproval("s-resume", approvalId, { approved: true, message: "继续" })).toEqual({
      resolved: true,
      needsResume: true,
      kind: "approval",
      interactionId: approvalId,
      rootRunId: "root-run",
      approvalId,
      toolCallId: "tool-resume",
    });
    expect(service.takeApprovalMeta(approvalId)).toMatchObject({
      task: "完整根任务",
      executionKind: "daemon.cron",
      runId: "child-run",
      rootRunId: "root-run",
    });
    await expect(service.waitForApproval({
      sessionId: "s-resume",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "call-agent-1",
      toolCallId: "tool-resume",
      deadlineMs: 0,
      task: "完整根任务",
      toolName: "execute_bash",
    })).resolves.toMatchObject({ approved: true, message: "继续" });
    store.close();
  });

  it("超时输入响应发布 responded 事件并标记恢复", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const service = new PendingInteractionService(new DurableClientEventPublisher(store, dispatcher));
    store.createSession(LOCAL_TENANT_ID, "s-input-resume", "usr_local");

    const suspended = service.waitForUserInput({
      sessionId: "s-input-resume",
      runId: "run-input-resume",
      rootRunId: "run-input-resume",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-input-resume",
      deadlineMs: 0,
      task: "询问用户",
      prompt: "请输入名称",
    });
    const inputId = realtimeEvents.getHistory("s-input-resume")[0]?.call_id ?? "";
    await expect(suspended).rejects.toBeInstanceOf(RecoverableInterrupt);

    expect(service.respondUserInput("s-input-resume", inputId, { value: "Alice" })).toMatchObject({
      resolved: true,
      needsResume: true,
      rootRunId: "run-input-resume",
      toolCallId: "tool-input-resume",
    });
    expect(realtimeEvents.getHistory("s-input-resume").at(-1)).toMatchObject({
      type: "interaction",
      call_id: inputId,
      payload: { kind: "user_input", phase: "responded", value: "Alice" },
    });
    store.close();
  });

  it("命中 approvalCache 后一次消费且不发布 required 事件", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const service = new PendingInteractionService(new DurableClientEventPublisher(store, dispatcher));
    store.createSession(LOCAL_TENANT_ID, "s-cache", "usr_local");
    service.setApprovalCache("s-cache", "tool-cache", { approved: true, message: "已缓存批准" });

    await expect(service.waitForApproval({
      sessionId: "s-cache",
      runId: "run-cache",
      rootRunId: "run-cache",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-cache",
      deadlineMs: 0,
      task: "执行命令",
      toolName: "execute_bash",
    })).resolves.toMatchObject({ approved: true, message: "已缓存批准" });
    expect(realtimeEvents.getHistory("s-cache")).toEqual([]);

    const secondWait = service.waitForApproval({
      sessionId: "s-cache",
      runId: "run-cache",
      rootRunId: "run-cache",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-cache",
      deadlineMs: 0,
      task: "执行命令",
      toolName: "execute_bash",
    });
    await expect(secondWait).rejects.toMatchObject({
      sessionId: "s-cache",
      runId: "run-cache",
      rootRunId: "run-cache",
      toolCallId: "tool-cache",
      kind: "approval",
    } satisfies Partial<RecoverableInterrupt>);
    const approvalId = realtimeEvents.getHistory("s-cache")[0]?.call_id ?? "";
    expect(service.isApprovalPending("s-cache", approvalId)).toBe(false);
    store.close();
  });

  it("同一 batch 全部响应后才触发一次恢复", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const service = new PendingInteractionService(
      new DurableClientEventPublisher(store, new OutboxDispatcher(store, realtimeEvents)),
      store,
    );
    store.createSession(LOCAL_TENANT_ID, "s-batch", "usr_local");
    const batchId = "run-batch:call-1,call-2";
    const waits = ["call-1", "call-2"].map((toolCallId) => service.waitForApproval({
      sessionId: "s-batch",
      runId: "run-batch",
      rootRunId: "run-batch",
      parentRunId: null,
      parentCallId: null,
      toolCallId,
      interactionBatchId: batchId,
      deadlineMs: 0,
      task: "批量写入",
      toolName: "write_file",
    }));
    const approvalIds = realtimeEvents.getHistory("s-batch").map((event) => event.call_id ?? "");
    await Promise.all(waits.map((wait) => expect(wait).rejects.toBeInstanceOf(RecoverableInterrupt)));

    expect(service.respondApproval("s-batch", approvalIds[0]!, { approved: true, message: "允许一" })).toMatchObject({
      resolved: true,
      needsResume: false,
    });
    expect(service.respondApproval("s-batch", approvalIds[1]!, { approved: true, message: "允许二" })).toMatchObject({
      resolved: true,
      needsResume: true,
      rootRunId: "run-batch",
    });
    store.close();
  });

  it("同批部分实时响应后其结果仍保留给整批恢复消费", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const service = new PendingInteractionService(
      new DurableClientEventPublisher(store, new OutboxDispatcher(store, realtimeEvents)),
      store,
    );
    store.createSession(LOCAL_TENANT_ID, "s-partial", "usr_local");
    const base = {
      sessionId: "s-partial",
      runId: "run-partial",
      rootRunId: "run-partial",
      parentRunId: null,
      parentCallId: null,
      interactionBatchId: "batch-partial",
      task: "部分响应",
      toolName: "write_file",
    } as const;
    const first = service.waitForApproval({ ...base, toolCallId: "tool-live", deadlineMs: 1000 });
    const second = service.waitForApproval({ ...base, toolCallId: "tool-timeout", deadlineMs: 0 });
    const [firstId, secondId] = realtimeEvents.getHistory("s-partial").map((event) => event.call_id ?? "");

    expect(service.respondApproval("s-partial", firstId!, { approved: true, message: "提前批准" })).toMatchObject({ needsResume: false });
    await expect(first).resolves.toMatchObject({ approved: true });
    await expect(second).rejects.toBeInstanceOf(RecoverableInterrupt);
    expect(service.respondApproval("s-partial", secondId!, { approved: true, message: "最后批准" })).toMatchObject({ needsResume: true });
    service.takeApprovalMeta(secondId!, "s-partial");

    await expect(service.waitForApproval({ ...base, toolCallId: "tool-live", deadlineMs: 0 }))
      .resolves.toMatchObject({ approved: true, message: "提前批准" });
    store.close();
  });

  it("runtime 重建后仍可从 SQLite 响应并消费挂起审批", async () => {
    const dataRoot = makeTempRoot();
    const dbPath = path.join(dataRoot, "ragsystem.db");
    const firstStore = createConversationStore({ dbPath, dataRoot });
    firstStore.createSession(LOCAL_TENANT_ID, "s-durable", "usr_local");
    const realtimeEvents = new RealtimeEventHub();
    const firstPublisher = new DurableClientEventPublisher(firstStore, new OutboxDispatcher(firstStore, realtimeEvents));
    const firstService = new PendingInteractionService(firstPublisher, firstStore);
    const wait = firstService.waitForApproval({
      sessionId: "s-durable",
      runId: "run-durable",
      rootRunId: "run-durable",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-durable",
      interactionBatchId: "batch-durable",
      deadlineMs: 0,
      task: "重启恢复",
      executionKind: "daemon.feishu.incoming",
      toolName: "write_file",
    });
    const approvalId = realtimeEvents.getHistory("s-durable")[0]?.call_id ?? "";
    await expect(wait).rejects.toBeInstanceOf(RecoverableInterrupt);
    firstStore.close();

    const restoredStore = createConversationStore({ dbPath, dataRoot });
    const restoredPublisher = new DurableClientEventPublisher(restoredStore, new OutboxDispatcher(restoredStore, new RealtimeEventHub()));
    const restoredService = new PendingInteractionService(restoredPublisher, restoredStore);
    expect(restoredService.respondApproval("s-durable", approvalId, { approved: true, message: "重启后批准" })).toMatchObject({
      resolved: true,
      needsResume: true,
    });
    expect(restoredService.peekApprovalMeta(approvalId, "s-durable")).toMatchObject({
      rootRunId: "run-durable",
      toolCallId: "tool-durable",
    });
    restoredService.takeApprovalMeta(approvalId, "s-durable");
    await expect(restoredService.waitForApproval({
      sessionId: "s-durable",
      runId: "run-durable",
      rootRunId: "run-durable",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-durable",
      interactionBatchId: "batch-durable",
      deadlineMs: 0,
      task: "重启恢复",
      toolName: "write_file",
    })).resolves.toMatchObject({ approved: true, message: "重启后批准" });
    expect(restoredStore.getPendingInteraction("s-durable", approvalId)?.status).toBe("consumed");
    restoredStore.close();
  });

  it("user_input 缓存命中后直接返回且不进入等待", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const service = new PendingInteractionService(new DurableClientEventPublisher(store, dispatcher));
    store.createSession(LOCAL_TENANT_ID, "s-input-cache", "usr_local");
    service.setApprovalCache("s-input-cache", "tool-input", { value: "缓存输入" });

    await expect(service.waitForUserInput({
      sessionId: "s-input-cache",
      runId: "run-input",
      rootRunId: "run-input",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-input",
      deadlineMs: 0,
      task: "采集输入",
      prompt: "请输入",
    })).resolves.toMatchObject({ value: "缓存输入" });
    expect(realtimeEvents.getHistory("s-input-cache")).toEqual([]);
    store.close();
  });
});

import { describe, expect, it, vi } from "vitest";

import type { ExecutionSessionPort } from "../src/contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "../src/services/agent/execution/runtime-core-service.js";
import type { AgentExecutionStatusTracker } from "../src/services/agent/execution/status-tracker.js";
import type { TenantId } from "../src/identity/types.js";
import type { ClientEventPublisher } from "../src/services/runtime/event-outbox/client-event-publisher.js";
import type { RuntimeStorage } from "../src/contracts/storage/runtime-storage.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import type { AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { AgentCompressionService } from "../src/services/agent/context-compression/compression-service.js";
import {
  createCommandRefPart,
  parseSlashCommand,
  SlashCommandHandler,
} from "../src/services/agent/execution/slash-command-handler.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

describe("slash command content semantics", () => {
  it("captures prompt command Agent text in a stable command_ref snapshot", () => {
    const command = parseSlashCommand("/review src/app.ts");
    expect(command).toMatchObject({
      name: "review",
      args: "src/app.ts",
      mode: "prompt",
    });

    const first = createCommandRefPart(command!, "/review src/app.ts", "cmd-fixed");
    const second = createCommandRefPart(command!, "/review src/app.ts", "cmd-fixed");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      type: "command_ref",
      invocation_id: "cmd-fixed",
      raw_text: "/review src/app.ts",
      resolution: {
        kind: "prompt",
        agent_text: "请对以下内容进行全面的代码审查，包括代码质量、安全性和性能优化建议：src/app.ts",
        snapshot_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
  });

  it("stores a system command_ref and its correlated command_result", async () => {
    const added: Array<Record<string, unknown>> = [];
    const sessions = {
      getSession: vi.fn(async () => ({ session_id: "session-1" })),
      addMessage: vi.fn(async (input: Record<string, unknown>) => {
        const message = {
          id: `message-${added.length + 1}`,
          ...input,
          content_parts: input.contentParts,
        };
        added.push(message);
        return message;
      }),
    } as unknown as ExecutionSessionPort;
    const clientEvents = { publish: vi.fn(async () => undefined) } as unknown as ClientEventPublisher;
    const handler = new SlashCommandHandler(
      "tenant-1" as TenantId,
      sessions,
      {} as AgentExecutionStatusTracker,
      {} as RuntimeExecutionConfigResolver,
      () => [],
      null,
      clientEvents,
      { operations: {} } as RuntimeStorage,
    );

    const command = parseSlashCommand("/help")!;
    const result = await handler.handle({
      sessionId: "session-1",
      sessionIdentity: {
        sessionId: "session-1",
        ownerUserId: "user-1",
        visibility: "private",
        originType: "direct",
        originId: null,
        originChannel: "web",
        workspaceId: null,
        teamSnapshot: createTestTeamSnapshot(),
        metadata: {},
        permissionMode: null,
      },
      userId: "user-1",
      requestId: "request-1",
      selectedLlm: "",
      command,
      originalTask: "/help",
    });

    expect(result?.success).toBe(true);
    expect(result?.contentParts).toEqual([expect.objectContaining({
      type: "command_result",
      name: "help",
      success: true,
      text: expect.any(String),
    })]);
    expect(added).toHaveLength(2);
    expect(added[0]?.contentParts).toEqual([expect.objectContaining({
      type: "command_ref",
      name: "help",
      raw_text: "/help",
      resolution: { kind: "system" },
    })]);
    const commandRef = (added[0]?.contentParts as Array<{ invocation_id: string }>)[0]!;
    expect(added[1]?.contentParts).toEqual([expect.objectContaining({
      type: "command_result",
      invocation_id: commandRef.invocation_id,
      name: "help",
      success: true,
    })]);
    expect(added[0]?.metadata).toEqual({});
    expect(added[1]?.metadata).toEqual({});
    expect(clientEvents.publish).toHaveBeenCalledTimes(2);
    expect(clientEvents.publish).toHaveBeenNthCalledWith(
      1,
      "session-1",
      expect.objectContaining({
        type: "state_sync",
        payload: expect.objectContaining({
          category: "message_saved",
          ref: expect.objectContaining({ content_parts: expect.any(Array) }),
        }),
      }),
      expect.any(Object),
    );
  });
});

describe("compact compression progress frames", () => {
  type CompressionFrameEnvelope = { payload?: { category?: string; detail?: Record<string, unknown> } };

  const PROVIDERS: ModelProviderConfig[] = [
    {
      key: "pqy",
      name: "pqy",
      provider_type: "zhipuai",
      api_format: "anthropic",
      api_key: "sk-test",
      models: [{ name: "glm-test" }],
    },
  ];

  function buildCompactAgent(): AgentConfig {
    return {
      agent_name: "orchestrator_agent",
      enabled: true,
      default_entry: true,
      llm_tiers: {
        default: { provider: "pqy", provider_type: "zhipuai", model_name: "glm-test", extra_params: {} },
      },
      tools: { enabled_tools: [] },
      goals: { enabled: false },
      tasks: { background: false },
      delegation: { enabled_agents: [], parallel_children: false },
      custom_params: {},
    } as AgentConfig;
  }

  function buildCompactHarness(
    forceCompact: AgentCompressionService["forceCompact"],
    { withEphemeral = true }: { withEphemeral?: boolean } = {},
  ) {
    const agent = buildCompactAgent();
    const sessions = {
      getSession: vi.fn(async () => ({ session_id: "session-1", team_snapshot: createTestTeamSnapshot("orchestrator_agent", [agent]) })),
      addMessage: vi.fn(async (input: Record<string, unknown>) => ({
        id: `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ...input,
        content_parts: input.contentParts,
      })),
      updateSessionMetadata: vi.fn(async () => ({})),
    } as unknown as ExecutionSessionPort;
    const maintenanceControllers = new Map<string, AbortController>();
    const statusTracker = {
      getStatusBySession: vi.fn(() => undefined),
      registerMaintenanceAbort: vi.fn((sessionId: string, controller: AbortController) => {
        maintenanceControllers.set(sessionId, controller);
      }),
      unregisterMaintenanceAbort: vi.fn((sessionId: string, controller?: AbortController) => {
        if (!controller || maintenanceControllers.get(sessionId) === controller) maintenanceControllers.delete(sessionId);
      }),
      cancelMaintenanceAbort: vi.fn((sessionId: string, reason = "user_stop") => {
        const controller = maintenanceControllers.get(sessionId);
        if (!controller) return false;
        if (!controller.signal.aborted) controller.abort(new Error(reason));
        return true;
      }),
    } as unknown as AgentExecutionStatusTracker;
    const runtimeCore = {
      resolveExecutionConfig: vi.fn(() => ({
        readiness: { configuration_ready: true, requirements: [] },
        agent,
        provider: PROVIDERS[0],
        modelName: "glm-test",
      })),
    } as unknown as RuntimeExecutionConfigResolver;
    const runtimeStorage = {
      operations: {
        getActiveRootRun: vi.fn(async () => undefined),
        claimSessionMaintenance: vi.fn(async () => ({ claimed: true })),
        renewSessionMaintenance: vi.fn(async () => true),
        releaseSessionMaintenance: vi.fn(async () => undefined),
      },
    } as unknown as RuntimeStorage;
    // 两条通道按调用时间记录 compression 帧：断言依赖帧序（started 在 summary 前），
    // 不能按通道拼接。
    const orderedCompressionFrames: Array<{ channel: "durable" | "ephemeral"; detail: Record<string, unknown> }> = [];
    const recordCompression = (channel: "durable" | "ephemeral") => (_sessionId: string, event: CompressionFrameEnvelope) => {
      if (event?.payload?.category === "compression") {
        orderedCompressionFrames.push({ channel, detail: event.payload.detail! });
      }
      return undefined;
    };
    const publishMock = vi.fn(async (sessionId: string, event: unknown) => recordCompression("durable")(sessionId, event as CompressionFrameEnvelope));
    const publishEphemeralMock = vi.fn(async (sessionId: string, event: unknown) => recordCompression("ephemeral")(sessionId, event as CompressionFrameEnvelope));
    const clientEvents = {
      publish: publishMock,
      // 部署无实时通道时不暴露 publishEphemeral：瞬时帧应降级 durable publish，不静默丢帧。
      ...(withEphemeral ? { publishEphemeral: publishEphemeralMock } : {}),
    } as unknown as ClientEventPublisher;
    const handler = new SlashCommandHandler(
      "tenant-1" as TenantId,
      sessions,
      statusTracker,
      runtimeCore,
      () => PROVIDERS,
      { forceCompact } as unknown as AgentCompressionService,
      clientEvents,
      runtimeStorage,
    );
    const run = () => handler.handle({
      sessionId: "session-1",
      sessionIdentity: {
        sessionId: "session-1",
        ownerUserId: "user-1",
        visibility: "private",
        originType: "direct",
        originId: null,
        originChannel: "web",
        workspaceId: null,
        teamSnapshot: createTestTeamSnapshot("orchestrator_agent", [agent]),
        metadata: {},
        permissionMode: null,
      },
      userId: "user-1",
      requestId: "request-1",
      selectedLlm: "",
      command: parseSlashCommand("/compact")!,
      originalTask: "/compact",
    });
    return {
      run,
      publishMock,
      publishEphemeralMock,
      get compressionFrames() { return orderedCompressionFrames.map((entry) => entry.detail); },
      get compressionChannels() { return orderedCompressionFrames.map((entry) => entry.channel); },
      // 模拟 stopSession 的 maintenance 分支：中止本会话注册的压缩控制器。
      stopCompact: () => (statusTracker as unknown as { cancelMaintenanceAbort: (sessionId: string, reason: string) => boolean })
        .cancelMaintenanceAbort("session-1", "user_stop"),
    };
  }

  it("publishes started then a content-bearing summary frame on success", async () => {
    const forceCompact = vi.fn(async (input: { onSummarizeStart?: () => void }) => {
      input.onSummarizeStart?.();
      return {
        status: "success" as const,
        reason: "success",
        budgetTokens: 1000,
        historyTokens: 2000,
        thresholdTokens: 850,
        summaryMessage: {
          id: "summary-1",
          seq: 21,
          session_id: "session-1",
          role: "assistant",
          content_parts: [{ type: "text", text: "摘要正文" }],
          metadata: {},
          created_at: "2026-09-03T00:00:00Z",
          thread_key: "root",
          child_agent_id: null,
        },
        replacedMessageCount: 14,
        replacesUpToSeq: 14,
      };
    });
    const harness = buildCompactHarness(forceCompact as AgentCompressionService["forceCompact"]);

    const result = await harness.run();

    expect(result?.success).toBe(true);
    expect(result?.content).toContain("压缩完成");
    const frames = harness.compressionFrames;
    // started 是瞬态帧走 ephemeral（不落 outbox）；summary 是 durable 帧（进重连回放）。
    expect(harness.publishEphemeralMock).toHaveBeenCalledOnce();
    expect(harness.publishEphemeralMock.mock.calls[0]![1]).toMatchObject({
      payload: { category: "compression", detail: { type: "compression_started", forced: true } },
    });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "compression_started", forced: true, thread_key: "root" });
    expect(frames[1]).toMatchObject({
      type: "compression_summary",
      forced: true,
      content: "摘要正文",
      conversation_scope: "root",
      replaced_message_count: 14,
      replaces_up_to_seq: 14,
    });
  });

  it("publishes a finished frame when the summary model is unavailable", async () => {
    const forceCompact = vi.fn(async (input: { onSummarizeStart?: () => void }) => {
      input.onSummarizeStart?.();
      return {
        status: "skipped" as const,
        reason: "summary_unavailable",
        budgetTokens: 1000,
        historyTokens: 2000,
        thresholdTokens: 850,
        replacedMessageCount: 0,
        replacesUpToSeq: null,
      };
    });
    const harness = buildCompactHarness(forceCompact as AgentCompressionService["forceCompact"]);

    const result = await harness.run();

    expect(result?.success).toBe(false);
    expect(result?.content).toContain("摘要模型不可用");
    const frames = harness.compressionFrames;
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "compression_started", forced: true });
    expect(frames[1]).toMatchObject({ type: "compression_finished", forced: true, reason: "summary_unavailable" });
  });

  it("publishes no compression frames when there is nothing to compress", async () => {
    // 选段失败不触发 onSummarizeStart：不点灯也就无需收尾，零帧是回归保护。
    const forceCompact = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "insufficient_candidates",
      budgetTokens: 1000,
      historyTokens: 10,
      thresholdTokens: 850,
      replacedMessageCount: 0,
      replacesUpToSeq: null,
    }));
    const harness = buildCompactHarness(forceCompact as AgentCompressionService["forceCompact"]);

    const result = await harness.run();

    expect(result?.success).toBe(true);
    expect(result?.content).toContain("无需压缩");
    expect(harness.compressionFrames).toHaveLength(0);
  });

  it("用户停止压缩：signal 传入 forceCompact，abort 后以 stopped 收尾并注销/释放租约", async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const forceCompact = vi.fn(async (input: {
      onSummarizeStart?: () => void;
      signal?: AbortSignal;
    }) => {
      seenSignals.push(input.signal);
      input.onSummarizeStart?.();
      // 真实链路：摘要 LLM 请求挂 signal，abort 时以错误落地（传输层掐断 HTTP）。
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("user_stop")), { once: true });
      });
    });
    const harness = buildCompactHarness(forceCompact as AgentCompressionService["forceCompact"]);

    const pending = harness.run();
    await vi.waitFor(() => {
      // handle 已注册维护控制器（进入 forceCompact 之后才可停止）。
      expect(forceCompact).toHaveBeenCalled();
    });
    expect(harness.stopCompact()).toBe(true);
    const result = await pending;

    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    expect(result?.success).toBe(false);
    expect(result?.content).toContain("压缩已停止");
    const frames = harness.compressionFrames;
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "compression_started", forced: true });
    expect(frames[1]).toMatchObject({ type: "compression_finished", reason: "user_stop", forced: true });
    // started/finished 均走 ephemeral；durable 通道只有 message_saved/command_result。
    expect(harness.publishEphemeralMock).toHaveBeenCalledTimes(2);
  });

  it("部署无实时通道时（无 publishEphemeral）瞬时帧降级 durable publish，不静默丢帧", async () => {
    const forceCompact = vi.fn(async (input: { onSummarizeStart?: () => void }) => {
      input.onSummarizeStart?.();
      return {
        status: "skipped" as const,
        reason: "summary_unavailable",
        budgetTokens: 1000,
        historyTokens: 2000,
        thresholdTokens: 850,
        replacedMessageCount: 0,
        replacesUpToSeq: null,
      };
    });
    const harness = buildCompactHarness(forceCompact as AgentCompressionService["forceCompact"], { withEphemeral: false });

    await harness.run();

    expect(harness.publishEphemeralMock).not.toHaveBeenCalled();
    const frames = harness.compressionFrames;
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ type: "compression_finished", reason: "summary_unavailable", forced: true });
  });
});

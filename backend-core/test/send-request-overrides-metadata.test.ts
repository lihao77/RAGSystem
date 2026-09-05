import { describe, expect, it, vi } from "vitest";

import { createLaunchers, SESSION_REQUEST_OVERRIDES_METADATA_KEY } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

/**
 * 会话级请求覆盖（selected_llm / thinking_level）：sendUserMessage 是所有
 * 外部用户消息的唯一入口（WS/HTTP/回滚重试/collaborate 共用）。语义为会话维度
 * 设定：请求未携带 → 继承会话 _request_overrides；显式 null → 清除；有值 → 生效。
 * durable 会话起点之后把实际生效值写回 session metadata，供前端恢复对话回显、
 * 审计与系统渠道（mailbox/goal/挂起恢复等）读回。
 */
function createHarness(sessionMetadata: Record<string, unknown> | null = null) {
    const updateSessionMetadata = vi.fn(async () => ({}));
    const durable = (() => {
      let resolve!: (value: { kind: string }) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<{ kind: string }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    })();
    const invoke = vi.fn((input: Record<string, unknown>) => ({
      promise: Promise.resolve({}),
      durableStarted: durable.promise,
      started: true,
      session_id: "session-1",
      run_id: "run-1",
      request_id: "request-1",
      kind: "agent_run",
    }));
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: {
        getSession: vi.fn(async () => (sessionMetadata === null ? null : {
          session_id: "session-1",
          team_snapshot: createTestTeamSnapshot(),
          tenant_id: "tenant-1",
          owner_user_id: "user-1",
          visibility: "private",
          origin_type: "direct",
          origin_id: null,
          origin_channel: "web",
          workspace_id: null,
          metadata: sessionMetadata,
          permission_mode: null,
        })),
        updateSessionMetadata,
      } as never,
      runtimeCore: {
        createTeamSnapshot: vi.fn(() => createTestTeamSnapshot()),
        resolveExecutionConfig: vi.fn(() => ({
          readiness: { configuration_ready: true, requirements: [] },
          agent: { agent_name: "orchestrator_agent" },
          provider: { name: "provider-1", provider_type: "openai" },
          modelName: "model-1",
        })),
      } as never,
      slashCommandHandler: { handle: vi.fn(async () => null) } as never,
      attachmentResolver: { resolve: vi.fn(async () => ({ attachments: [] })) } as never,
      statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: { invoke } as never,
      notificationQueue: {} as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun: vi.fn(async () => null) } } as never,
      clientEvents: {} as never,
      mailbox: null,
      runReader: null as never,
      participantRuns: {} as never,
      transformUserMessage: null,
    });
    return { launchers, updateSessionMetadata, durable, invoke };
}

const baseRequest = {
  session_id: "session-1",
  userId: "user-1",
  task: "画一张图",
  attachments: [],
} as never;

describe("sendUserMessage 请求级覆盖落库", () => {
  it("带覆盖的发送在 durable 起点后写入 _request_overrides", async () => {
    const { launchers, updateSessionMetadata, durable } = createHarness();

    // startStream 自身会 await durableStarted（HTTP 响应在 durable 起点后给出），
    // 测试里并发 resolve，避免互相等待。
    const resultPromise = launchers.startStream({
      ...(baseRequest as object),
      selected_llm: "ali|alibaba|deepseek-v4-flash",
      thinking_level: "high",
    } as never, "request-1");
    expect(updateSessionMetadata).not.toHaveBeenCalled();
    durable.resolve({ kind: "completed" });
    const result = await resultPromise;

    expect(result.started).toBe(true);
    await vi.waitFor(() => expect(updateSessionMetadata).toHaveBeenCalledTimes(1));
    expect(updateSessionMetadata).toHaveBeenCalledWith("session-1", {
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
        selected_llm: "ali|alibaba|deepseek-v4-flash",
        thinking_level: "high",
        updated_at: expect.any(String),
      },
    });
  });

  it("未覆盖的发送写 null（抹掉旧覆盖，语义 = 最后一次发送生效的值）", async () => {
    const { launchers, updateSessionMetadata, durable } = createHarness();

    const resultPromise = launchers.startStream(baseRequest, "request-2");
    durable.resolve({ kind: "completed" });
    const result = await resultPromise;

    expect(result.started).toBe(true);
    await vi.waitFor(() => expect(updateSessionMetadata).toHaveBeenCalledTimes(1));
    expect(updateSessionMetadata).toHaveBeenCalledWith("session-1", {
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
        selected_llm: null,
        thinking_level: null,
        updated_at: expect.any(String),
      },
    });
  });

  it("durable 起点失败或写入失败都不影响发送结果", async () => {
    const { launchers, updateSessionMetadata, durable } = createHarness();

    // durable 起点失败：startStream 按失败上报（started:false），覆盖不落库、进程不崩
    const resultPromise = launchers.startStream(baseRequest, "request-3");
    durable.reject(new Error("durable start failed"));
    const result = await resultPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.started).toBe(false);
    expect(updateSessionMetadata).not.toHaveBeenCalled();

    // 写入失败：静默吞掉，发送结果不受影响
    const failing = createHarness();
    failing.updateSessionMetadata.mockRejectedValue(new Error("storage down"));
    const result2Promise = failing.launchers.startStream(baseRequest, "request-4");
    failing.durable.resolve({ kind: "completed" });
    const result2 = await result2Promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result2.started).toBe(true);
  });
});

describe("sendUserMessage 会话级设定三态（继承 / 清除 / 生效）", () => {
  const sessionWithSetting = {
    [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
      selected_llm: "ali|alibaba|qwen-max",
      thinking_level: "high",
      updated_at: "2026-09-05T00:00:00Z",
    },
  };

  it("请求未携带字段 → 继承会话设定并原值写回（设定不漂移）", async () => {
    const { launchers, updateSessionMetadata, durable, invoke } = createHarness(sessionWithSetting);

    const resultPromise = launchers.startStream(baseRequest, "request-10");
    durable.resolve({ kind: "completed" });
    const result = await resultPromise;

    expect(result.started).toBe(true);
    // 继承的模型与档位进入本次 run：invoke 收到 selectedLlm（readiness 解析形态）与 thinkingLevel。
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      selectedLlm: { provider: { name: "provider-1", provider_type: "openai" }, modelName: "model-1" },
      thinkingLevel: "high",
    }));
    await vi.waitFor(() => expect(updateSessionMetadata).toHaveBeenCalledTimes(1));
    expect(updateSessionMetadata).toHaveBeenCalledWith("session-1", {
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
        selected_llm: "ali|alibaba|qwen-max",
        thinking_level: "high",
        updated_at: expect.any(String),
      },
    });
  });

  it("显式 null → 清除设定（invoke 不带覆盖，metadata 写 null）", async () => {
    const { launchers, updateSessionMetadata, durable, invoke } = createHarness(sessionWithSetting);

    const resultPromise = launchers.startStream({
      ...(baseRequest as object),
      selected_llm: null,
      thinking_level: null,
    } as never, "request-11");
    durable.resolve({ kind: "completed" });
    const result = await resultPromise;

    expect(result.started).toBe(true);
    const invocation = invoke.mock.calls[0]![0];
    expect(invocation.selectedLlm).toBeUndefined();
    expect(invocation.thinkingLevel).toBeUndefined();
    await vi.waitFor(() => expect(updateSessionMetadata).toHaveBeenCalledTimes(1));
    expect(updateSessionMetadata).toHaveBeenCalledWith("session-1", {
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
        selected_llm: null,
        thinking_level: null,
        updated_at: expect.any(String),
      },
    });
  });

  it("请求携带新值 → 覆盖会话设定并写回新值", async () => {
    const { launchers, updateSessionMetadata, durable, invoke } = createHarness(sessionWithSetting);

    const resultPromise = launchers.startStream({
      ...(baseRequest as object),
      selected_llm: "pqy|zhipuai|glm-5",
      thinking_level: "off",
    } as never, "request-12");
    durable.resolve({ kind: "completed" });
    const result = await resultPromise;

    expect(result.started).toBe(true);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      selectedLlm: { provider: { name: "provider-1", provider_type: "openai" }, modelName: "model-1" },
      thinkingLevel: "off",
    }));
    await vi.waitFor(() => expect(updateSessionMetadata).toHaveBeenCalledTimes(1));
    expect(updateSessionMetadata).toHaveBeenCalledWith("session-1", {
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
        selected_llm: "pqy|zhipuai|glm-5",
        thinking_level: "off",
        updated_at: expect.any(String),
      },
    });
  });

  it("会话设定畸形（枚举外档位）→ 按未设定收敛，不炸发送", async () => {
    const malformed = {
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: { selected_llm: "ali|qwen-max", thinking_level: "ultra" },
    };
    const { launchers, durable, invoke } = createHarness(malformed);

    const resultPromise = launchers.startStream(baseRequest, "request-13");
    durable.resolve({ kind: "completed" });
    const result = await resultPromise;

    expect(result.started).toBe(true);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      selectedLlm: { provider: { name: "provider-1", provider_type: "openai" }, modelName: "model-1" },
    }));
    const invocation = invoke.mock.calls[0]![0];
    expect(invocation.thinkingLevel).toBeUndefined();
  });
});

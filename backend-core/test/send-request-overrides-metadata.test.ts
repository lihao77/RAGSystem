import { describe, expect, it, vi } from "vitest";

import { createLaunchers, SESSION_REQUEST_OVERRIDES_METADATA_KEY } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

/**
 * 请求级覆盖（selected_llm / thinking_level）的会话落库：sendUserMessage 是所有
 * 外部用户消息的唯一入口（WS/HTTP/回滚重试共用），在 durable 会话起点之后把
 * "最后一次发送生效的覆盖"写入 session metadata，供前端恢复对话回显与审计。
 */
describe("sendUserMessage 请求级覆盖落库", () => {
  function createHarness() {
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
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: {
        getSession: vi.fn(async () => null),
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
      invocationService: {
        invoke: vi.fn(() => ({
          promise: Promise.resolve({}),
          durableStarted: durable.promise,
          started: true,
          session_id: "session-1",
          run_id: "run-1",
          request_id: "request-1",
          kind: "agent_run",
        })),
      } as never,
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
    return { launchers, updateSessionMetadata, durable };
  }

  const baseRequest = {
    session_id: "session-1",
    userId: "user-1",
    task: "画一张图",
    attachments: [],
  } as never;

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

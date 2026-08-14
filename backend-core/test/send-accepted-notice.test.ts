import { describe, expect, it, vi } from "vitest";

import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

/**
 * send 前置确认（onAccepted）：基础校验后、耗时处理（附件解析/插件变换/落库/启动）前恰好触发一次。
 * realtime 通道据此立即回 phase=received 的 ACK；其后失败由调用方以 error 帧补偿。
 */
describe("startStream onAccepted（send 前置确认）", () => {
  function createHarness(overrides: {
    attachmentResolve?: () => Promise<{ error?: string; attachments?: never[] }>;
    slashHandle?: ReturnType<typeof vi.fn>;
  } = {}) {
    const accepted: Array<{ kind?: "command" }> = [];
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: { getSession: vi.fn(async () => null) } as never,
      runtimeCore: { createTeamSnapshot: vi.fn(() => createTestTeamSnapshot()) } as never,
      slashCommandHandler: { handle: overrides.slashHandle ?? vi.fn(async () => null) } as never,
      attachmentResolver: { resolve: vi.fn(overrides.attachmentResolve ?? (async () => ({ attachments: [] }))) } as never,
      statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: {} as never,
      notificationQueue: {} as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun: vi.fn(async () => null) } } as never,
      clientEvents: {} as never,
      mailbox: null,
      runReader: null,
      participantRuns: {} as never,
      transformUserMessage: null,
    });
    return { launchers, accepted };
  }

  const streamRequest = {
    session_id: "session-1",
    userId: "user-1",
    task: "看下这张图",
    attachments: [{ file_id: "file-1" }],
  } as never;

  it("agent 路径：onAccepted 在附件解析完成前触发，且恰好一次", async () => {
    let releaseAttachment!: (value: { error: string }) => void;
    const gate = new Promise<{ error: string }>((resolve) => { releaseAttachment = resolve; });
    const { launchers, accepted } = createHarness({ attachmentResolve: () => gate });

    let settled = false;
    const pending = launchers.startStream(streamRequest, "request-1", {
      onAccepted: (notice) => { accepted.push(notice); },
    }).then((result) => { settled = true; return result; });

    // 附件解析阻塞期间：onAccepted 已触发、startStream 未完成——ACK 与耗时处理解耦。
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    expect(settled).toBe(false);
    expect(accepted[0]).toEqual({});

    // 前置确认后的失败：startStream 以 started:false 收尾（调用方改发 error 帧补偿）。
    releaseAttachment({ error: "附件读取失败" });
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toBe("附件读取失败");
    expect(accepted).toHaveLength(1);
  });

  it("前置校验失败：onAccepted 不触发，维持同步失败返回", async () => {
    const { launchers, accepted } = createHarness();

    const result = await launchers.startStream(
      { session_id: "session-1", userId: "user-1", task: "", attachments: [] } as never,
      "request-2",
      { onAccepted: (notice) => { accepted.push(notice); } },
    );

    expect(result.started).toBe(false);
    expect(result.error).toMatch(/empty/);
    expect(accepted).toHaveLength(0);
  });

  it("命令路径：onAccepted 携带 kind=command（时机与原先一致）", async () => {
    const slashHandle = vi.fn(async () => ({
      start: { started: true, session_id: "session-1", kind: "command" },
      success: true,
      content: "已压缩",
      contentParts: [{ type: "text", text: "已压缩" }],
    }));
    const { launchers, accepted } = createHarness({ slashHandle });

    const result = await launchers.startStream(
      { session_id: "session-1", userId: "user-1", task: "/compact", attachments: [] } as never,
      "request-3",
      { onAccepted: (notice) => { accepted.push(notice); } },
    );

    expect(accepted).toEqual([{ kind: "command" }]);
    expect(result.kind).toBe("command");
  });

  it("未传 onAccepted 时行为不变（可选契约）", async () => {
    const { launchers } = createHarness({
      attachmentResolve: async () => ({ error: "附件读取失败" }),
    });

    const result = await launchers.startStream(streamRequest, "request-4");

    expect(result.started).toBe(false);
    expect(result.error).toBe("附件读取失败");
  });
});

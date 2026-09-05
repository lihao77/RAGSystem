import { describe, expect, it, vi } from "vitest";

import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

/**
 * 持久化前变换的主模型视觉能力传递：发送时按 launchRun 同一口径（agent 默认档 +
 * selectedLlm 覆盖）解析主模型，能力位从模型条目 input_modalities 派生（与执行期
 * profile 投影同源）决定 transformer 收到的 mainModelSupportsVision——多模态模型下
 * 插件跳过冗余的视觉辅助描述。
 */
describe("sendUserMessage 主模型视觉能力传递", () => {
  function createHarness(overrides: {
    provider?: Record<string, unknown> | null;
    configurationReady?: boolean;
  } = {}) {
    const capturedInputs: Array<Record<string, unknown>> = [];
    const resolveExecutionConfig = vi.fn(() => ({
      readiness: {
        configuration_ready: overrides.configurationReady ?? true,
        requirements: [],
      },
      ...(overrides.provider ? { agent: { agent_name: "orchestrator_agent" } } : {}),
      provider: overrides.provider ?? null,
      modelName: overrides.provider ? "model-1" : null,
    }));
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: { getSession: vi.fn(async () => null) } as never,
      runtimeCore: {
        createTeamSnapshot: vi.fn(() => createTestTeamSnapshot()),
        resolveExecutionConfig,
      } as never,
      slashCommandHandler: { handle: vi.fn(async () => null) } as never,
      attachmentResolver: { resolve: vi.fn(async () => ({ attachments: [] })) } as never,
      statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: {
        invoke: vi.fn(() => ({
          promise: Promise.resolve({}),
          durableStarted: Promise.resolve({ kind: "completed" }),
          started: true,
          session_id: "session-1",
          run_id: "run-1",
          request_id: "request-1",
          kind: "agent_run",
        })),
      } as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun: vi.fn(async () => null) } } as never,
      clientEvents: {} as never,
      mailbox: null,
      runReader: null as never,
      participantRuns: {} as never,
      transformUserMessage: vi.fn(async (input: Record<string, unknown>) => {
        capturedInputs.push(input);
        return null;
      }) as never,
    });
    return { launchers, capturedInputs, resolveExecutionConfig };
  }

  const streamRequest = {
    session_id: "session-1",
    userId: "user-1",
    task: "看下这张图",
    attachments: [{ file_id: "file-1" }],
  } as never;

  it.each([
    ["模型条目输入模态含 image", [{ name: "model-1", input_modalities: ["text", "image"] }], true],
    ["模型条目纯文本模态", [{ name: "model-1", input_modalities: ["text"] }], false],
    ["模型条目未声明模态（能力未知按不支持处理）", [{ name: "model-1" }], false],
    ["模型条目缺失（名称不匹配）", [{ name: "other-model", input_modalities: ["text", "image"] }], false],
  ])("多模态主模型（%s）向 transformer 传递 mainModelSupportsVision", async (_name, models, expected) => {
    const { launchers, capturedInputs } = createHarness({
      provider: { name: "provider-1", provider_type: "openai", models },
    });

    const result = await launchers.startStream(streamRequest, "request-1");

    expect(result.started).toBe(true);
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.mainModelSupportsVision).toBe(expected);
  });

  it("provider 级残留的废弃 supports_vision 不再被采信（能力位只从模型条目派生）", async () => {
    const { launchers, capturedInputs } = createHarness({
      provider: {
        name: "provider-1",
        provider_type: "openai",
        supports_vision: true,
        models: [{ name: "model-1", input_modalities: ["text"] }],
      },
    });

    await launchers.startStream(streamRequest, "request-legacy");

    expect(capturedInputs[0]?.mainModelSupportsVision).toBe(false);
  });

  it("selectedLlm 覆盖时按覆盖后的模型解析", async () => {
    const { launchers, capturedInputs, resolveExecutionConfig } = createHarness({
      provider: { name: "provider-1", provider_type: "openai", models: [{ name: "model-1", input_modalities: ["text", "image"] }] },
    });

    await launchers.startStream({ ...(streamRequest as object), selected_llm: "provider-1/model-1" } as never, "request-2");

    expect(resolveExecutionConfig).toHaveBeenCalledWith(expect.objectContaining({ selectedLlm: "provider-1/model-1" }));
    expect(capturedInputs[0]?.mainModelSupportsVision).toBe(true);
  });

  it("selectedLlm 覆盖解析到纯文本模型时标志跟随覆盖结果（非默认档缓存值）", async () => {
    const { launchers, capturedInputs, resolveExecutionConfig } = createHarness({
      provider: { name: "provider-1", provider_type: "openai", models: [{ name: "model-1", input_modalities: ["text", "image"] }] },
    });
    resolveExecutionConfig.mockImplementation(() => ({
      readiness: { configuration_ready: true, requirements: [] },
      agent: { agent_name: "orchestrator_agent" },
      provider: { name: "provider-1", provider_type: "openai", models: [{ name: "model-1", input_modalities: ["text"] }] },
      modelName: "model-1",
    }));

    await launchers.startStream({ ...(streamRequest as object), selected_llm: "provider-1/model-1" } as never, "request-4");

    expect(capturedInputs[0]?.mainModelSupportsVision).toBe(false);
  });

  it("主模型解析失败时不传标志（transformer 保持原行为）", async () => {
    const { launchers, capturedInputs } = createHarness({ provider: null, configurationReady: false });

    const result = await launchers.startStream(streamRequest, "request-3");

    expect(result.started).toBe(false); // launchRun 以 readiness 失败收尾
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.mainModelSupportsVision).toBeUndefined();
  });
});

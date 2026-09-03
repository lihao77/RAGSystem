import { describe, expect, it, vi } from "vitest";

import {
  sanitizeSessionTitle,
  SessionTitleService,
  type SessionTitleServiceDeps,
} from "../src/services/sessions/session-title-service.js";

const systemLlm = {
  provider: "main",
  provider_type: "openai",
  model_name: "gpt-mini",
  temperature: 0.3,
  max_completion_tokens: 1024,
  max_context_tokens: 8192,
  extra_params: {},
};

function buildDeps(overrides: Partial<SessionTitleServiceDeps> = {}) {
  const complete = vi.fn(async () => ({ content: "修复登录超时" }));
  const updateSessionListTitle = vi.fn<(sessionId: string, title: string) => Promise<void>>();
  const deps: SessionTitleServiceDeps = {
    updateSessionListTitle,
    systemConfig: { getLlmConfig: () => ({ ...systemLlm }) },
    modelProviders: {
      listProviders: () => [
        {
          key: "main",
          name: "Main Provider",
          provider_type: "openai",
          api_format: "openai_chat",
          models: [],
          api_key: "sk-test",
        },
        {
          key: "cheap",
          name: "Cheap Provider",
          provider_type: "openai",
          api_format: "openai_chat",
          models: [],
          api_key: "sk-cheap",
        },
      ],
    },
    llmClient: { complete },
    ...overrides,
  };
  return { deps, complete, updateSessionListTitle };
}

describe("sanitizeSessionTitle", () => {
  it("keeps plain titles untouched", () => {
    expect(sanitizeSessionTitle("修复登录超时")).toBe("修复登录超时");
  });

  it("takes the first non-empty line, strips wrapping quotes and collapses whitespace", () => {
    expect(sanitizeSessionTitle("\n「修复登录超时」\n")).toBe("修复登录超时");
    expect(sanitizeSessionTitle("\"fix login timeout\"\nsecond line")).toBe("fix login timeout");
    expect(sanitizeSessionTitle("  fix   login \n timeout  ")).toBe("fix login");
  });

  it("caps length at 30 characters without splitting surrogate pairs", () => {
    expect(sanitizeSessionTitle("a".repeat(50))).toBe("a".repeat(30));
    expect(sanitizeSessionTitle("😀".repeat(50))).toBe("😀".repeat(30));
  });

  it("returns empty for blank input", () => {
    expect(sanitizeSessionTitle("   \n  ")).toBe("");
  });
});

describe("SessionTitleService.generateTitle", () => {
  it("sanitizes the LLM output and writes it back", async () => {
    const complete = vi.fn(async () => ({ content: "\n「修复登录超时」。\n" }));
    const { deps, updateSessionListTitle } = buildDeps({ llmClient: { complete } });
    await new SessionTitleService(deps).generateTitle("session-1", "登录偶尔超时，帮我看看");

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-mini",
      // 思考必须显式关闭：fast 档常是默认开思考的轻量模型，小预算下思考块会
      // 耗尽产出上限导致正文为空（线上曾因 glm-5.3-flash 默认思考复现）。
      thinkingLevel: "off",
      maxCompletionTokens: expect.any(Number),
    }));
    expect(updateSessionListTitle).toHaveBeenCalledWith("session-1", "修复登录超时");
  });

  it("skips when the message text is empty", async () => {
    const { deps, complete, updateSessionListTitle } = buildDeps();
    await new SessionTitleService(deps).generateTitle("session-1", "   ");
    expect(complete).not.toHaveBeenCalled();
    expect(updateSessionListTitle).not.toHaveBeenCalled();
  });

  it("skips when the system LLM is not configured", async () => {
    const { deps, complete } = buildDeps({
      systemConfig: { getLlmConfig: () => ({ ...systemLlm, provider: "", model_name: "" }) },
    });
    await new SessionTitleService(deps).generateTitle("session-1", "帮我修复登录超时");
    expect(complete).not.toHaveBeenCalled();
  });

  it("skips when the provider cannot be resolved", async () => {
    const { deps, complete, updateSessionListTitle } = buildDeps({
      modelProviders: { listProviders: () => [] },
    });
    await new SessionTitleService(deps).generateTitle("session-1", "帮我修复登录超时");
    expect(complete).not.toHaveBeenCalled();
    expect(updateSessionListTitle).not.toHaveBeenCalled();
  });

  it("does not write back when the sanitized result is empty", async () => {
    const { deps, updateSessionListTitle } = buildDeps({
      llmClient: { complete: vi.fn(async () => ({ content: " \n " })) },
    });
    await new SessionTitleService(deps).generateTitle("session-1", "帮我修复登录超时");
    expect(updateSessionListTitle).not.toHaveBeenCalled();
  });
});

describe("SessionTitleService tier resolution (fast → default → system LLM)", () => {
  const fastTier = { provider: "cheap", provider_type: "openai", model_name: "cheap-fast-model", extra_params: {} };
  const defaultTier = { provider: "main", provider_type: "openai", model_name: "default-model", extra_params: {} };

  it("prefers the agent fast tier over the system LLM", async () => {
    const complete = vi.fn(async () => ({ content: "标题" }));
    const { deps } = buildDeps({
      llmClient: { complete },
      getAgentLlmTiers: async () => ({ fast: { ...fastTier }, default: { ...defaultTier } }),
    });
    await new SessionTitleService(deps).generateTitle("session-1", "帮我修复登录超时");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "cheap-fast-model" }));
  });

  it("falls to the default tier when fast is missing or half-configured", async () => {
    const complete = vi.fn(async () => ({ content: "标题" }));
    const { deps } = buildDeps({
      llmClient: { complete },
      getAgentLlmTiers: async () => ({
        fast: { ...fastTier, model_name: null }, // 半空条目：缺 model_name，不进候选
        default: { ...defaultTier },
      }),
    });
    await new SessionTitleService(deps).generateTitle("session-1", "帮我修复登录超时");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "default-model" }));
  });

  it("falls back to the system LLM when the agent has no tiers or resolution fails", async () => {
    const complete = vi.fn(async () => ({ content: "标题" }));
    const noTiers = buildDeps({
      llmClient: { complete },
      getAgentLlmTiers: async () => null,
    });
    await new SessionTitleService(noTiers.deps).generateTitle("session-1", "帮我修复登录超时");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-mini" }));

    const throwing = buildDeps({
      llmClient: { complete },
      getAgentLlmTiers: async () => {
        throw new Error("agent config unavailable");
      },
    });
    await new SessionTitleService(throwing.deps).generateTitle("session-1", "帮我修复登录超时");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-mini" }));
  });

  it("degrades past a fast tier whose provider is no longer in the provider list", async () => {
    const complete = vi.fn(async () => ({ content: "标题" }));
    const { deps } = buildDeps({
      llmClient: { complete },
      getAgentLlmTiers: async () => ({ fast: { provider: "unknown-provider", provider_type: "openai", model_name: "m", extra_params: {} } }),
    });
    await new SessionTitleService(deps).generateTitle("session-1", "帮我修复登录超时");
    // fast 档指向已删除的 provider：候选链继续降级到系统 LLM
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-mini" }));
  });
});

describe("SessionTitleService.notifyFirstVisibleUserMessage", () => {
  it("dedupes concurrent notifications per session", async () => {
    const gate = { release: () => {} };
    const released = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const complete = vi.fn(async () => {
      await released;
      return { content: "标题" };
    });
    const { deps } = buildDeps({ llmClient: { complete } });
    const service = new SessionTitleService(deps);

    service.notifyFirstVisibleUserMessage("session-1", "第一条");
    service.notifyFirstVisibleUserMessage("session-1", "并发第二条");
    gate.release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("swallows generation failures without surfacing them", async () => {
    const logger = { warn: vi.fn() };
    const { deps, updateSessionListTitle } = buildDeps({
      llmClient: { complete: vi.fn(async () => {
        throw new Error("provider down");
      }) },
      logger,
    });
    const service = new SessionTitleService(deps);

    expect(() => service.notifyFirstVisibleUserMessage("session-1", "第一条")).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith("session title generation failed", expect.objectContaining({
      sessionId: "session-1",
    }));
    expect(updateSessionListTitle).not.toHaveBeenCalled();

    // 失败后会话不再被去重锁住：下次首条消息（如回滚重发）可再次触发
    const retry = buildDeps();
    const retryService = new SessionTitleService(retry.deps);
    retryService.notifyFirstVisibleUserMessage("session-1", "重新提问");
    await new Promise((resolve) => setImmediate(resolve));
    expect(retry.updateSessionListTitle).toHaveBeenCalledWith("session-1", "修复登录超时");
  });
});

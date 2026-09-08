import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ModelsDevCatalog } from "../src/services/integrations/models-dev-catalog.js";

/** 缩小版 models.dev api.json：原生 SDK 厂商/兼容网关厂商/官方 SDK 无兼容端点厂商 + 思考形状选项。 */
const API_FIXTURE = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "Omni-era GPT",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 128000, output: 16384 },
        tool_call: true,
        reasoning: false,
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
      },
      "bare-model": { id: "bare-model", name: "Bare", tool_call: false },
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        // "bogus" 验证值域过滤到已知强度档位
        reasoning_options: [{ type: "effort", values: ["medium", "bogus", "low", "high"] }],
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-chat": {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        modalities: { input: ["TEXT", "audio", "bogus", "audio"], output: ["text"] },
        limit: { context: 64000 },
        // toggle+effort 同模型：可接受集两形状并列，推荐 effort（分级最细）
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        interleaved: { field: "reasoning_content" },
      },
    },
  },
  alibaba: {
    id: "alibaba",
    name: "Alibaba",
    api: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: {
      "qwen3-max": {
        id: "qwen3-max",
        name: "Qwen3 Max",
        reasoning: true,
        // 纯 toggle（无 effort 值域）：qwen 系启停开关 → 推荐 toggle（budget 亦在可接受集）
        reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1024, max: 262144 }],
      },
    },
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    npm: "@ai-sdk/mistral",
    models: { "mistral-large": { id: "mistral-large", name: "Mistral Large" } },
  },
} as const;

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => normalizedHeaders[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-dev-catalog-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ModelsDevCatalog", () => {
  it("首次拉取归一厂商摘要（按名称排序）与模型条目（模态过滤/limit 缺省/cost）", async () => {
    const calls: RecordedCall[] = [];
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      baseUrl: "https://mirror.test/api.json",
      fetchImpl: (url, init) => {
        calls.push({ url: String(url), headers: headerRecord(init) });
        return Promise.resolve(makeResponse(200, API_FIXTURE, { ETag: '"abc"' }));
      },
      now: () => 1_000_000,
      ttlMs: 60_000,
    });

    const providers = await catalog.listProviders();
    expect(providers).toEqual({
      available: true,
      stale: false,
      providers: [
        // 接入档案推导：npm SDK 家族 → 原生格式；api 端点 → openai_chat；皆无 → null 不可直连。
        // 思考形状已下沉到每模型条目（推荐值/可接受集），厂商级不再投票。
        {
          id: "alibaba",
          name: "Alibaba",
          api_base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          api_format: "openai_chat",
          model_count: 1,
        },
        { id: "deepseek", name: "DeepSeek", api_base_url: "https://api.deepseek.com", api_format: "openai_chat", model_count: 1 },
        { id: "mistral", name: "Mistral", api_base_url: null, api_format: null, model_count: 1 },
        { id: "openai", name: "OpenAI", api_base_url: null, api_format: "openai_chat", model_count: 3 },
      ],
    });

    const openai = await catalog.listModels("openai");
    expect(openai?.available).toBe(true);
    expect(openai?.provider).toEqual({ id: "openai", name: "OpenAI", api_base_url: null, api_format: "openai_chat", model_count: 3 });
    expect(openai?.models[0]).toEqual({
      id: "gpt-4o",
      name: "GPT-4o",
      description: "Omni-era GPT",
      input_modalities: ["text", "image", "pdf"],
      output_modalities: ["text"],
      context_limit: 128000,
      output_limit: 16384,
      tool_call: true,
      reasoning: false,
      accepted_thinking_kinds: [],
      recommended_thinking_kind: "none",
      reasoning_efforts: [],
      interleaved: false,
      interleaved_field: null,
      cost: { input: 2.5, output: 10 },
    });
    expect(openai?.models[1]).toEqual({
      id: "bare-model",
      name: "Bare",
      description: null,
      input_modalities: [],
      output_modalities: [],
      context_limit: null,
      output_limit: null,
      tool_call: false,
      reasoning: null,
      accepted_thinking_kinds: [],
      recommended_thinking_kind: null,
      reasoning_efforts: [],
      interleaved: false,
      interleaved_field: null,
      cost: null,
    });
    // effort 值域进模型条目（供按模型收缩思考档位）；形状集/推荐值按每模型直出。
    expect(openai?.models[2]).toEqual({
      id: "gpt-5",
      name: "GPT-5",
      description: null,
      input_modalities: [],
      output_modalities: [],
      context_limit: null,
      output_limit: null,
      tool_call: null,
      reasoning: true,
      accepted_thinking_kinds: ["effort"],
      recommended_thinking_kind: "effort",
      reasoning_efforts: ["low", "medium", "high"],
      interleaved: false,
      interleaved_field: null,
      cost: null,
    });

    const deepseek = await catalog.listModels("deepseek");
    // 模态大小写归一、未知值过滤、去重。
    expect(deepseek?.models[0]?.input_modalities).toEqual(["text", "audio"]);
    expect(deepseek?.models[0]?.output_limit).toBeNull();
    // effort 值域过滤到已知强度档位并按全集顺序输出；interleaved 兼容 bool 与 {field} 形态。
    expect(deepseek?.models[0]?.reasoning_efforts).toEqual(["low", "high", "max"]);
    expect(deepseek?.models[0]?.interleaved).toBe(true);
    expect(deepseek?.models[0]?.interleaved_field).toBe("reasoning_content");
    // toggle+effort 同模型：可接受集两形状都列，推荐 effort（分级最细）
    expect(deepseek?.models[0]?.accepted_thinking_kinds).toEqual(["effort", "toggle"]);
    expect(deepseek?.models[0]?.recommended_thinking_kind).toBe("effort");
    // qwen 系模型：toggle+budget_tokens → 可接受集两形状、推荐 toggle（无 effort 值域）
    const alibaba = await catalog.listModels("alibaba");
    expect(alibaba?.models[0]?.reasoning_efforts).toEqual([]);
    expect(alibaba?.models[0]?.accepted_thinking_kinds).toEqual(["toggle", "budget"]);
    expect(alibaba?.models[0]?.recommended_thinking_kind).toBe("toggle");

    expect(await catalog.listModels("unknown-vendor")).toBeNull();
    expect(calls).toEqual([{ url: "https://mirror.test/api.json", headers: {} }]);
  });

  it("TTL 内复用内存快照不出网；过期后带 If-None-Match 条件请求，304 刷新时间戳", async () => {
    let clock = 1_000_000;
    const calls: RecordedCall[] = [];
    let respond304 = false;
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: (url, init) => {
        calls.push({ url: String(url), headers: headerRecord(init) });
        return Promise.resolve(
          respond304 ? makeResponse(304, null, { ETag: '"abc"' }) : makeResponse(200, API_FIXTURE, { ETag: '"abc"' }),
        );
      },
      now: () => clock,
      ttlMs: 60_000,
    });

    await catalog.listProviders();
    await catalog.listModels("openai");
    expect(calls.length).toBe(1);

    clock += 30_000;
    await catalog.listProviders();
    expect(calls.length).toBe(1);

    clock += 31_000;
    respond304 = true;
    const refreshed = await catalog.listProviders();
    expect(calls.length).toBe(2);
    expect(calls[1]?.headers["if-none-match"]).toBe('"abc"');
    expect(refreshed).toMatchObject({ available: true, stale: false });
    expect(refreshed.providers.length).toBe(4);
  });

  it("重新校验失败回退旧快照（stale:true）；从未成功拉取 → available:false", async () => {
    let clock = 1_000_000;
    let fail = false;
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(makeResponse(200, API_FIXTURE, { ETag: '"abc"' }))),
      now: () => clock,
      ttlMs: 60_000,
    });

    await catalog.listProviders();
    clock += 61_000;
    fail = true;
    const stale = await catalog.listProviders();
    expect(stale).toMatchObject({ available: true, stale: true });
    expect(stale.providers.length).toBe(4);

    const fresh = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: () => Promise.reject(new Error("offline")),
      now: () => clock,
      ttlMs: 60_000,
    });
    const unavailable = await fresh.listProviders();
    expect(unavailable).toEqual({ available: false, stale: false, providers: [] });
    // 不可用时未知厂商不报 404，而是降级壳（调用方按 available 引导手填）。
    expect((await fresh.listModels("deepseek"))?.available).toBe(false);
  });

  it("磁盘缓存：冷启动复用快照免出网，随后过期再走条件请求", async () => {
    const dir = makeTempDir();
    let clock = 1_000_000;
    const calls: RecordedCall[] = [];
    const fetchImpl = (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: headerRecord(init) });
      return Promise.resolve(makeResponse(200, API_FIXTURE, { ETag: '"abc"' }));
    };

    const first = new ModelsDevCatalog({ dataRoot: dir, fetchImpl, now: () => clock, ttlMs: 60_000 });
    await first.listProviders();
    expect(calls.length).toBe(1);
    expect(fs.existsSync(path.join(dir, "cache", "models-dev-api.json"))).toBe(true);

    const second = new ModelsDevCatalog({ dataRoot: dir, fetchImpl, now: () => clock, ttlMs: 60_000 });
    const hydrated = await second.listProviders();
    expect(hydrated).toMatchObject({ available: true, stale: false });
    expect(hydrated.providers.length).toBe(4);
    expect(calls.length).toBe(1);

    clock += 61_000;
    const revalidated = await second.listProviders();
    expect(calls.length).toBe(2);
    expect(revalidated).toMatchObject({ available: true, stale: false });
  });

  it("单飞：并发调用共享同一次出网校验", async () => {
    let pending: ((response: Response) => void) | undefined;
    const calls: RecordedCall[] = [];
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: (url, init) => {
        calls.push({ url: String(url), headers: headerRecord(init) });
        return new Promise<Response>((resolve) => {
          pending = resolve;
        });
      },
      now: () => 1_000_000,
      ttlMs: 60_000,
    });

    const first = catalog.listProviders();
    const second = catalog.listModels("openai");
    await Promise.resolve();
    expect(calls.length).toBe(1);
    pending?.(makeResponse(200, API_FIXTURE, { ETag: '"abc"' }));
    const [providersResult, modelsResult] = await Promise.all([first, second]);
    expect(providersResult.available).toBe(true);
    expect(modelsResult?.models.length).toBe(3);
    expect(calls.length).toBe(1);
  });

  it("拉取超时按失败处理（保留/降级，不抛错）", async () => {
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
      now: () => 1_000_000,
      ttlMs: 60_000,
      timeoutMs: 10,
    });

    const result = await catalog.listProviders();
    expect(result).toEqual({ available: false, stale: false, providers: [] });
  });

  it("从未成功时失败退避：负缓存窗口内重复调用不再出网，窗口过后重试", async () => {
    let clock = 1_000_000;
    const calls: RecordedCall[] = [];
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: (url, init) => {
        calls.push({ url: String(url), headers: headerRecord(init) });
        return Promise.reject(new Error("offline"));
      },
      now: () => clock,
      ttlMs: 60_000,
    });

    await catalog.listProviders();
    expect(calls.length).toBe(1);
    await catalog.listProviders();
    await catalog.listModels("deepseek");
    expect(calls.length).toBe(1);

    clock += 61_000;
    const retried = await catalog.listProviders();
    expect(calls.length).toBe(2);
    expect(retried.available).toBe(false);
    // 重试又失败：新一轮退避窗口内不再出网
    await catalog.listProviders();
    expect(calls.length).toBe(2);
  });

  it("格式推导补全：gemini 官方 SDK → gemini；专用云 SDK（bedrock）→ null 不可直连", async () => {
    const fixture = {
      google: {
        id: "google",
        name: "Google",
        npm: "@ai-sdk/google",
        models: { "gemini-3-pro": { id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning_options: [{ type: "toggle" }] } },
      },
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        // 全 toggle-only 模型：旧规则投票会声明 toggle，anthropic 线上无落点后不再推导
        models: { "claude-x": { id: "claude-x", name: "Claude X", reasoning_options: [{ type: "toggle" }] } },
      },
      "amazon-bedrock": {
        id: "amazon-bedrock",
        name: "Amazon Bedrock",
        npm: "@ai-sdk/amazon-bedrock",
        models: { "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet" } },
      },
    };
    const catalog = new ModelsDevCatalog({
      dataRoot: makeTempDir(),
      fetchImpl: () => Promise.resolve(makeResponse(200, fixture, { ETag: '"g"' })),
      now: () => 1_000_000,
      ttlMs: 60_000,
    });

    const providers = await catalog.listProviders();
    expect(providers.providers).toEqual([
      { id: "amazon-bedrock", name: "Amazon Bedrock", api_base_url: null, api_format: null, model_count: 1 },
      { id: "anthropic", name: "Anthropic", api_base_url: null, api_format: "anthropic", model_count: 1 },
      { id: "google", name: "Google", api_base_url: null, api_format: "gemini", model_count: 1 },
    ]);
  });
});

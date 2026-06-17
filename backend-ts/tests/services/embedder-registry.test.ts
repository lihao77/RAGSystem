import { describe, expect, it } from "vitest";

import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import type { EmbeddingClient } from "../../src/services/integrations/embedding-client.js";
import {
  createEmbedder,
  HashFallbackEmbedder,
  RemoteEmbedder,
} from "../../src/services/integrations/embedder-registry.js";

/**
 * embedder-registry 单测:验证 createEmbedder 按 provider_type 选 Remote/Hash、
 * RemoteEmbedder 维度惰性缓存、HashFallbackEmbedder 64 维归一化。
 */
const provider = (overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({
  name: "p",
  provider_type: "openai_chat",
  models: [],
  model_map: {},
  api_key: "k",
  ...overrides,
});

describe("embedder-registry", () => {
  it("createEmbedder 已知 provider_type → RemoteEmbedder(semantic)", () => {
    const embedder = createEmbedder(provider(), "m");
    expect(embedder).toBeInstanceOf(RemoteEmbedder);
    expect(embedder.semantic).toBe(true);
    expect(embedder.key).toBe("remote:p/m");
  });

  it("createEmbedder 无 provider → HashFallbackEmbedder", () => {
    const embedder = createEmbedder(null, "m");
    expect(embedder).toBeInstanceOf(HashFallbackEmbedder);
    expect(embedder.semantic).toBe(false);
    expect(embedder.dimension).toBe(64);
  });

  it("createEmbedder 未知 provider_type → HashFallbackEmbedder(降级)", () => {
    const embedder = createEmbedder(provider({ provider_type: "unknown_xyz" }), "m");
    expect(embedder).toBeInstanceOf(HashFallbackEmbedder);
  });

  it("HashFallbackEmbedder embed 64 维 + L2 归一化", async () => {
    const embedder = new HashFallbackEmbedder();
    const [vector] = await embedder.embed(["hello world 你好"]);
    expect(vector).toHaveLength(64);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("RemoteEmbedder 维度惰性缓存(注入 mock client)", async () => {
    const mockClient: EmbeddingClient = { embed: async () => [[0.1, 0.2, 0.3]] };
    const embedder = new RemoteEmbedder(provider(), "m", mockClient);
    expect(embedder.dimension).toBe(0); // 探测前
    await embedder.embed(["x"]);
    expect(embedder.dimension).toBe(3); // 探测后
  });

  it("RemoteEmbedder embed 透传 client 结果,空输入返回空数组", async () => {
    const mockClient: EmbeddingClient = { embed: async () => [[0.1, 0.2], [0.3, 0.4]] };
    const embedder = new RemoteEmbedder(provider(), "m", mockClient);
    await expect(embedder.embed([])).resolves.toEqual([]);
    await expect(embedder.embed(["a", "b"])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });
});

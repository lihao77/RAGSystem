import { describe, expect, it } from "vitest";

import {
  keywordOverlapScore,
  reciprocalRankFusionScore,
  RRF_K,
  tokenize,
} from "../../src/services/vector-store/scoring.js";

/**
 * scoring 单测:验证 keyword/hybrid 纯函数。
 */
describe("scoring", () => {
  it("keywordOverlapScore 英文 token 交集占比", () => {
    expect(keywordOverlapScore("hello world", "hello there")).toBeCloseTo(0.5, 5);
    expect(keywordOverlapScore("", "content")).toBe(0);
  });

  it("keywordOverlapScore 中文 bigram 命中", () => {
    expect(keywordOverlapScore("你好世界", "你好")).toBeGreaterThan(0);
  });

  it("tokenize 中文保留整词 + bigram + 英文 token", () => {
    const tokens = tokenize("机器学习 machine learning");
    expect(tokens).toContain("机器学习");
    expect(tokens).toContain("机器");
    expect(tokens).toContain("器学");
    expect(tokens).toContain("machine");
    expect(tokens).toContain("learning");
  });

  it("tokenize 按书写系统边界拆分连续中英文", () => {
    expect(tokenize("RAG知识库")).toEqual(["rag", "知识库", "知识", "识库"]);
    expect(tokenize("知识库RAG")).toEqual(["知识库", "知识", "识库", "rag"]);
  });

  it("RRF prioritizes chunks recalled by both sources and stays normalized", () => {
    const both = reciprocalRankFusionScore({ vectorRank: 1, keywordRank: 1, activeSources: 2 });
    const vectorOnly = reciprocalRankFusionScore({ vectorRank: 1, keywordRank: null, activeSources: 2 });
    expect(RRF_K).toBe(60);
    expect(both).toBeCloseTo(1, 5);
    expect(vectorOnly).toBeCloseTo(0.5, 5);
    expect(both).toBeGreaterThan(vectorOnly);
  });
});

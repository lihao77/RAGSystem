import { describe, expect, it } from "vitest";

import {
  HYBRID_KEYWORD_WEIGHT,
  HYBRID_VECTOR_WEIGHT,
  cosineSimilarity,
  hybridScore,
  keywordOverlapScore,
  tokenize,
} from "../../src/services/vector-store/scoring.js";

/**
 * scoring 单测:验证 cosine/keyword/hybrid/tokenize 纯函数(搬自 vector-library-service,语义不变)。
 */
describe("scoring", () => {
  it("cosineSimilarity 相同=1,正交=0", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.9746, 3);
  });

  it("cosineSimilarity 零向量防除零返回 0", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("cosineSimilarity 不同长度按最长对齐(补 0)", () => {
    expect(cosineSimilarity([1, 1], [1, 1, 0])).toBeCloseTo(1, 5);
  });

  it("keywordOverlapScore 英文 token 交集占比", () => {
    expect(keywordOverlapScore("hello world", "hello there")).toBeCloseTo(0.5, 5);
    expect(keywordOverlapScore("", "content")).toBe(0);
  });

  it("keywordOverlapScore 中文 bigram 命中", () => {
    expect(keywordOverlapScore("你好世界", "你好")).toBeGreaterThan(0);
  });

  it("hybridScore = vector*0.7 + keyword*0.3", () => {
    expect(hybridScore(1, 0)).toBeCloseTo(HYBRID_VECTOR_WEIGHT, 5);
    expect(hybridScore(0, 1)).toBeCloseTo(HYBRID_KEYWORD_WEIGHT, 5);
    expect(hybridScore(0.5, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("tokenize 中文保留整词 + bigram + 英文 token", () => {
    const tokens = tokenize("机器学习 machine learning");
    expect(tokens).toContain("机器学习");
    expect(tokens).toContain("机器");
    expect(tokens).toContain("器学");
    expect(tokens).toContain("machine");
    expect(tokens).toContain("learning");
  });
});

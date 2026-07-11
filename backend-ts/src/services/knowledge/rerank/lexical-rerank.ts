import type { VectorSearchResult } from "../../../contracts/vector-library.js";
import { keywordOverlapScore } from "../../vector-store/scoring.js";

/** 词法重排：提升关键词重合度，用于显式 lexical 策略和模型失败后的降级。 */
export function lexicalRerank(results: VectorSearchResult[], query: string): VectorSearchResult[] {
  return results
    .map((result) => {
      const rerankScore = keywordOverlapScore(query, result.content);
      return { ...result, rerank_score: rerankScore, score: result.score + rerankScore };
    })
    .sort((left, right) => (right.rerank_score ?? 0) - (left.rerank_score ?? 0));
}

/**
 * 向量检索打分纯函数(搬自 vector-library-service.ts:1508-1555 + 1434-1444)。
 *
 * driver 层(SqliteVecDriver.search)负责召回 + vector_score;keyword/hybrid/rerank 是检索策略,
 * 由编排层(Batch 5 的 VectorLibraryService.search)调本模块补到 VectorSearchHit。
 *
 * 纯函数无副作用、无 DB 依赖,可独立单测。hybrid 权重 vector*0.7 + keyword*0.3(沿用现值,可调)。
 */

export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function keywordOverlapScore(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) {
    return 0;
  }
  const contentTokens = new Set(tokenize(content));
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.size;
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.flatMap((word) => {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 1) {
      const grams: string[] = [word];
      for (let index = 0; index < word.length - 1; index += 1) {
        grams.push(word.slice(index, index + 2));
      }
      return grams;
    }
    return [word];
  });
}

export const HYBRID_VECTOR_WEIGHT = 0.7;
export const HYBRID_KEYWORD_WEIGHT = 0.3;

export function hybridScore(vectorScore: number, keywordScore: number): number {
  return vectorScore * HYBRID_VECTOR_WEIGHT + keywordScore * HYBRID_KEYWORD_WEIGHT;
}

/**
 * 向量检索打分纯函数。
 *
 * driver 层分别负责向量与关键词召回;应用层用 RRF 融合并可继续执行 rerank。
 *
 * 纯函数无副作用、无 DB 依赖,可独立单测。
 */

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
  return words.flatMap((word) => splitTokenByScript(word).flatMap(expandToken));
}

const HAN_CHARACTER = /^\p{Script=Han}$/u;

function splitTokenByScript(word: string): string[] {
  const segments: string[] = [];
  let current = "";
  let currentIsHan: boolean | null = null;
  for (const character of word) {
    const isHan = HAN_CHARACTER.test(character);
    if (current && currentIsHan !== isHan) {
      const normalized = trimTokenSeparators(current);
      if (normalized) segments.push(normalized);
      current = "";
    }
    current += character;
    currentIsHan = isHan;
  }
  const normalized = trimTokenSeparators(current);
  if (normalized) segments.push(normalized);
  return segments;
}

function trimTokenSeparators(value: string): string {
  return value.replace(/^[_-]+|[_-]+$/g, "");
}

function expandToken(token: string): string[] {
  if (!/^[\p{Script=Han}]+$/u.test(token) || token.length <= 1) return [token];
  const grams: string[] = [token];
  for (let index = 0; index < token.length - 1; index += 1) {
    grams.push(token.slice(index, index + 2));
  }
  return grams;
}

export const RRF_K = 60;

/** Normalized reciprocal-rank fusion. A result present in every active recall source can reach 1. */
export function reciprocalRankFusionScore(input: {
  vectorRank: number | null;
  keywordRank: number | null;
  activeSources: number;
  k?: number;
}): number {
  const k = Math.max(1, input.k ?? RRF_K);
  const activeSources = Math.max(1, input.activeSources);
  const raw = (input.vectorRank === null ? 0 : 1 / (k + input.vectorRank))
    + (input.keywordRank === null ? 0 : 1 / (k + input.keywordRank));
  const maximum = activeSources / (k + 1);
  return Math.max(0, Math.min(1, raw / maximum));
}

/** 千/百万缩写：1234 → 1.2k，2500000 → 2.5m；小于 1000 原样显示。 */
export function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const inK = n / 1_000;
  // 999.95 是 trimOneDecimal 进位到 1000 的临界，到达即升档到 m，避免显示 "1000k"。
  if (inK < 999.95) return `${trimOneDecimal(inK)}k`;
  return `${trimOneDecimal(n / 1_000_000)}m`;
}

function trimOneDecimal(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

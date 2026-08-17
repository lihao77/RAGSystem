/**
 * context-builder 辅助函数(自 SDK context/helpers.ts 迁入)。
 * 仅保留 history-view 仍在用的通用工具。
 */

/** 整数归一:非有限整数返回 null(history-view 读 seq 用)。 */
export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

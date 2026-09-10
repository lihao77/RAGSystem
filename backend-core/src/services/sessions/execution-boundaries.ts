import type { MessageInfo, SessionMessageListSnapshot } from "../../contracts/session/session.js";
import { hasExecutionRowContent } from "./execution-synthesis.js";

export function executionRunId(message: Pick<MessageInfo, "metadata">): string | null {
  const metadata = message.metadata ?? {};
  const runId = metadata.consumed_by_run_id ?? metadata.run_id;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

/** 显式边界优先；旧行按同 run 内最近的前置 user 归属，与历史执行回放共用。 */
export function groupExecutionRowsByBoundary(rows: readonly MessageInfo[]): Map<string, MessageInfo[]> {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const boundaryByRun = new Map<string, string>();
  // 兼容旧数据里执行行先于首条 user 行的形状。
  for (const row of ordered) {
    const runId = executionRunId(row);
    if (runId && row.role === "user" && !boundaryByRun.has(runId)) boundaryByRun.set(runId, row.id);
  }
  const segments = new Map<string, MessageInfo[]>();
  for (const row of ordered) {
    const runId = executionRunId(row);
    if (!runId) continue;
    if (row.role === "user") boundaryByRun.set(runId, row.id);
    const marker = row.metadata?.boundary_message_id;
    const boundary = typeof marker === "string" && marker ? marker : boundaryByRun.get(runId);
    if (!boundary) continue;
    const segment = segments.get(boundary) ?? [];
    segment.push(row);
    segments.set(boundary, segment);
  }
  return segments;
}

/** 可见列表不含工具/中间轮；原始行查询须在仓储层按候选 run 过滤，避免每页重读整个线程。 */
export async function getExecutionCarrierIds(
  messages: readonly MessageInfo[],
  loadPage: (limit: number, offset: number, runIds: readonly string[]) => Promise<Pick<SessionMessageListSnapshot, "items" | "has_more">>,
): Promise<Set<string>> {
  const candidates = messages.filter((message) => message.role === "user"
    && executionRunId(message) && message.metadata?.execution_history_discarded !== true);
  if (!candidates.length) return new Set();
  const runIds = [...new Set(candidates.map((message) => executionRunId(message)!))];
  const runIdSet = new Set(runIds);
  const rows: MessageInfo[] = [];
  let offset = 0;
  for (;;) {
    const page = await loadPage(1000, offset, runIds);
    rows.push(...page.items.filter((row) => runIdSet.has(executionRunId(row) ?? "")));
    offset += page.items.length;
    if (!page.has_more || !page.items.length) break;
  }
  const segments = groupExecutionRowsByBoundary(rows);
  return new Set(candidates
    .filter((message) => segments.get(message.id)?.some(hasExecutionRowContent))
    .map((message) => message.id));
}

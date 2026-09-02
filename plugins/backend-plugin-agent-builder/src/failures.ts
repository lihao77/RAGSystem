import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import { AGENT_TOOL_NAME } from "@ragsystem/backend-core/services/runtime/runtime-tool-bridge/registry.js";
import type { MessageFeedback, RunInfo } from "@ragsystem/backend-core/contracts/conversation-store/index.js";

/** 租户级被踩清单的单次扫描上限：回流消费的是「用户明确不满意的样本」，不是全量审计。 */
export const FEEDBACK_SCAN_LIMIT = 200;
/** 单个团队最多展开的会话数：样本再多也只是重复形态，控制转写读取成本。 */
const MAX_SESSIONS_PER_TEAM = 20;
const MESSAGES_PER_SESSION = 200;
const RUNS_PER_SESSION = 100;
const USER_EXCERPT_CHARS = 280;
const ANSWER_EXCERPT_CHARS = 600;
/** 入口 Agent 纯路由判定阈值：委派发生且入口自产文本不足此字符数。 */
const ROOT_ROUTER_TEXT_THRESHOLD = 80;

export interface TeamFailureSample {
  session_id: string;
  message_id: string;
  rated_at: string;
  comment: string | null;
  /** 被踩回答前最近一条用户消息的摘录（失败样本的「输入」侧）。 */
  user_excerpt: string | null;
  /** 被踩回答的摘录（失败样本的「输出」侧）。 */
  answer_excerpt: string | null;
  /** 产出该回答的 Agent：入口名或子 Agent 名（来自 run 树）。 */
  answered_by: string | null;
  run: {
    status: string | null;
    terminal_reason: string | null;
    task_summary: string | null;
  };
  /** D6 委派形态观察：该样本的交互窗口内入口 Agent 的委派与自产文本。 */
  delegate_calls: number;
  entry_own_text_chars: number;
  child_agents: string[];
  entry_router_only: boolean;
}

export interface TeamFailureReport {
  team_name: string;
  collected_at: string;
  /** 扫描过的租户级被踩行数（含其他团队）。 */
  feedback_rows_scanned: number;
  sessions_matched: number;
  samples: TeamFailureSample[];
}

export interface TeamFailureDependencies {
  readonly registry: RuntimeContainerRegistry;
  readonly tenantId: string;
}

export interface TeamFailureOptions {
  since?: string;
  feedbackLimit?: number;
}

/**
 * 失败回流（Phase 3a）：以租户级 👎 清单为锚点，反查归属目标团队的会话，
 * 把「用户输入 + 被踩回答 + 运行状态 + 委派形态」聚合成设计证据。
 * 与域探索产出同级：都是 Builder 构建团队时的先验输入，不是门禁。
 */
export async function collectTeamFailures(
  deps: TeamFailureDependencies,
  teamName: string,
  options?: TeamFailureOptions,
): Promise<TeamFailureReport> {
  const lease = await deps.registry.acquire(deps.tenantId);
  try {
    const runtime = lease.runtime;
    const feedback = await runtime.sessionApplication.listNegativeMessageFeedback({
      ...(options?.since ? { since: options.since } : {}),
      limit: options?.feedbackLimit ?? FEEDBACK_SCAN_LIMIT,
    });

    // 会话归属去重：同一会话的多条 👎 只展开一次转写，逐条生成样本
    const sessionIds: string[] = [];
    const seenSessions = new Set<string>();
    for (const row of feedback) {
      if (seenSessions.has(row.session_id)) continue;
      const session = await runtime.sessionApplication.getSession(row.session_id);
      if (!session || session.team_snapshot.team_name !== teamName) continue;
      seenSessions.add(row.session_id);
      sessionIds.push(row.session_id);
      if (sessionIds.length >= MAX_SESSIONS_PER_TEAM) break;
    }

    const samples: TeamFailureSample[] = [];
    for (const sessionId of sessionIds) {
      const [snapshot, runs] = await Promise.all([
        runtime.sessionApplication.listMessages({ sessionId, limit: MESSAGES_PER_SESSION }),
        runtime.sessionApplication.listRuns(sessionId, RUNS_PER_SESSION),
      ]);
      const messages = [...(snapshot?.items ?? [])].sort((left, right) => left.seq - right.seq);
      const sessionFeedback = feedback.filter((row) => row.session_id === sessionId);
      for (const row of sessionFeedback) {
        samples.push(buildSample(row, sessionId, messages, runs));
      }
    }
    samples.sort((left, right) => right.rated_at.localeCompare(left.rated_at));

    return {
      team_name: teamName,
      collected_at: new Date().toISOString(),
      feedback_rows_scanned: feedback.length,
      sessions_matched: sessionIds.length,
      samples,
    };
  } finally {
    lease.release();
  }
}

interface TrialMessageLike {
  id: string;
  seq: number;
  role: string;
  content_parts: readonly unknown[];
  child_agent_id: string | null;
  tool_calls?: ReadonlyArray<{ function?: { name?: string } }> | undefined;
}

function buildSample(
  row: MessageFeedback,
  sessionId: string,
  messages: readonly TrialMessageLike[],
  runs: readonly RunInfo[],
): TeamFailureSample {
  const ratedIndex = messages.findIndex((message) => message.id === row.message_id);
  const rated = ratedIndex >= 0 ? messages[ratedIndex] : null;

  let userExcerpt: string | null = null;
  let delegateCalls = 0;
  let entryOwnTextChars = 0;
  if (rated) {
    for (let index = ratedIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "user") continue;
      userExcerpt = excerpt(plainTextOf(message.content_parts), USER_EXCERPT_CHARS);
      break;
    }
    // 交互窗口 = 用户消息（含）到被踩回答（含）：观察入口在此窗口内干了什么
    let windowStart = ratedIndex;
    for (let index = ratedIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === "user") {
        windowStart = index;
        break;
      }
    }
    for (let index = windowStart; index <= ratedIndex; index += 1) {
      const message = messages[index];
      if (!message || message.role !== "assistant") continue;
      const calls = message.tool_calls ?? [];
      delegateCalls += calls.filter((call) => call.function?.name === AGENT_TOOL_NAME).length;
      if (message.child_agent_id == null) {
        entryOwnTextChars += plainTextOf(message.content_parts).length;
      }
    }
  }

  const ratedRun = rated
    ? runs.find((run) => run.final_message_id === row.message_id) ?? null
    : null;
  const answeredBy = rated?.child_agent_id
    ? runs.find((run) => run.child_agent_id === rated.child_agent_id)?.agent_name ?? null
    : ratedRun?.agent_name ?? null;
  const childAgents = [...new Set(
    runs
      .filter((run) => run.child_agent_id != null && run.agent_name != null)
      .map((run) => run.agent_name as string),
  )].slice(0, 10);

  return {
    session_id: sessionId,
    message_id: row.message_id,
    rated_at: row.updated_at,
    comment: row.comment ?? null,
    user_excerpt: userExcerpt,
    answer_excerpt: rated ? excerpt(plainTextOf(rated.content_parts), ANSWER_EXCERPT_CHARS) : null,
    answered_by: answeredBy,
    run: {
      status: ratedRun?.status ?? null,
      terminal_reason: ratedRun?.terminal_reason ?? null,
      task_summary: ratedRun?.task_summary ?? null,
    },
    delegate_calls: delegateCalls,
    entry_own_text_chars: entryOwnTextChars,
    child_agents: childAgents,
    entry_router_only: delegateCalls > 0 && entryOwnTextChars < ROOT_ROUTER_TEXT_THRESHOLD,
  };
}

function plainTextOf(parts: readonly unknown[] | undefined): string {
  if (!parts) return "";
  let text = "";
  for (const part of parts) {
    if (
      typeof part === "object" && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ) {
      text += `${(part as { text: string }).text}\n`;
    }
  }
  return text.trim();
}

function excerpt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

/** 证据文件正文：Builder 用 read_file 消费，人也能直接读。 */
export function renderTeamFailureMarkdown(report: TeamFailureReport): string {
  const lines: string[] = [
    `# 团队失败证据：${report.team_name}`,
    "",
    `采集时间：${report.collected_at}；扫描租户级 👎 ${report.feedback_rows_scanned} 条，命中会话 ${report.sessions_matched} 个，样本 ${report.samples.length} 条。`,
    "",
  ];
  if (report.samples.length === 0) {
    lines.push("该团队暂无被踩样本。没有失败证据时不要臆造教训，按域探索结论设计即可。");
    return `${lines.join("\n")}\n`;
  }
  report.samples.forEach((sample, index) => {
    lines.push(`## 样本 ${index + 1}（${sample.rated_at}，session ${sample.session_id}）`);
    lines.push(`- 用户输入：${sample.user_excerpt ?? "（转写中未找到，可能已被编辑或删除）"}`);
    lines.push(`- 被踩回答（by ${sample.answered_by ?? "unknown"}）：${sample.answer_excerpt ?? "（消息已删除）"}`);
    lines.push(`- 运行状态：${sample.run.status ?? "unknown"}${sample.run.terminal_reason ? ` / ${sample.run.terminal_reason}` : ""}${sample.run.task_summary ? ` — ${sample.run.task_summary}` : ""}`);
    lines.push(`- 委派形态：入口自产文本 ${sample.entry_own_text_chars} 字符，delegate 调用 ${sample.delegate_calls} 次${sample.child_agents.length > 0 ? `，子 Agent：${sample.child_agents.join("、")}` : ""}`);
    if (sample.entry_router_only) {
      lines.push("- ⚠️ 入口疑似纯路由：发生了委派但入口几乎不产出内容，按团队设计规范重新划分入口职责。");
    }
    if (sample.comment) lines.push(`- 用户备注：${sample.comment}`);
    lines.push("");
  });
  lines.push("消费方式：失败样本与域探索同级作为先验。把可复现的失败输入登记为 acceptance 用例（source: regression）；把形态性教训（路由化、答非所问、委派过深）写进对应 Agent 的 instructions；不要把单条偶发故障当成架构结论。");
  return `${lines.join("\n")}\n`;
}

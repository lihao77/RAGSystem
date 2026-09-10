import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
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
  /** 根 run 是否匹配到：false 时委派形态不可用（消息/run 超出扫描窗口或已删除）。 */
  run_linked: boolean;
  /** 会话团队快照的 team_revision：失败归因到发布版本（创建会话时的快照口径）。 */
  team_revision: string | null;
  /** 快照哈希解析回的发布草稿 revision；null = 不对应任何 Builder 发布（可能被直接改过团队）。 */
  published_revision: number | null;
  /** D6 委派形态观察：该样本的交互窗口内入口 Agent 的委派与自产文本。 */
  delegate_calls: number;
  entry_own_text_chars: number;
  child_agents: string[];
  entry_router_only: boolean;
}

export interface TeamFailureReport {
  team_name: string;
  /** 团队是否存在于当前租户注册表：不存在时不扫描、不产生样本（拼错团队名不该伪装成 0 样本）。 */
  team_exists: boolean;
  collected_at: string;
  /** 扫描过的租户级被踩行数（含其他团队；团队过滤发生在会话归属阶段）。 */
  tenant_rows_scanned: number;
  /** 行数达到扫描上限：历史里可能还有更早点踩，调大 feedback_limit 或用 since 分段。 */
  has_more: boolean;
  sessions_matched: number;
  /** 命中会话数达到上限（MAX_SESSIONS_PER_TEAM）：更早会话的样本未包含。 */
  sessions_truncated: boolean;
  /** 该团队的发布版本对照（revision ↔ 物化时团队哈希），样本归因与头部对照表的数据源。 */
  revision_links: Array<{
    revision: number;
    team_revision_hash: string;
    published_at: string | null;
  }>;
  samples: TeamFailureSample[];
}

export interface TeamFailureDependencies {
  readonly service: TeamFailureServiceAccess;
  readonly registry: RuntimeContainerRegistry;
  readonly tenantId: string;
}

/** Team 注册表与发布版本对照的结构性子集：tool 层注入 AgentBuilderService，测试可伪造。 */
export interface TeamFailureServiceAccess {
  getAgentConfigPort(): {
    listTeams(): Promise<{ teams: Array<{ team_name: string }> }>;
  };
  listPublishedTeamRevisions(): Promise<readonly {
    team_name: string;
    draft_id: string;
    revision: number;
    team_revision_hash: string;
    published_at: string | null;
  }[]>;
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
  // 先验团队存在性：不存在的团队直接返回 team_exists=false，不扫反馈也不产出误导性空样本
  const teamSummary = await deps.service.getAgentConfigPort().listTeams();
  const collectedAt = new Date().toISOString();
  if (!teamSummary.teams.some((team) => team.team_name === teamName)) {
    return {
      team_name: teamName,
      team_exists: false,
      collected_at: collectedAt,
      tenant_rows_scanned: 0,
      has_more: false,
      sessions_matched: 0,
      sessions_truncated: false,
      revision_links: [],
      samples: [],
    };
  }

  // 快照哈希 → 发布 revision：同一哈希被多版发布过时取最新（service 已按 revision 升序）
  const teamLinks = (await deps.service.listPublishedTeamRevisions())
    .filter((link) => link.team_name === teamName);
  const revisionByHash = new Map<string, number>();
  for (const link of teamLinks) {
    revisionByHash.set(link.team_revision_hash, link.revision);
  }

  // 存储层把 limit 静默钳到 [1,500]：按钳后口径计算 has_more，否则 limit>500 会假阴性
  const scanLimit = Math.min(options?.feedbackLimit ?? FEEDBACK_SCAN_LIMIT, 500);
  const lease = await deps.registry.acquire(deps.tenantId);
  try {
    const runtime = lease.runtime;
    const feedback = await runtime.sessionApplication.listNegativeMessageFeedback({
      ...(options?.since ? { since: options.since } : {}),
      limit: scanLimit,
    });
    const hasMore = feedback.length >= scanLimit;

    // 会话归属去重：同一 session_id 只反查一次（含外团队会话——不匹配也要去重，
    // 否则同一外团队会话的多条 👎 会逐行重复 getSession）
    const sessionIds: string[] = [];
    const sessionRevisions = new Map<string, string | null>();
    const seenSessions = new Set<string>();
    for (const row of feedback) {
      if (seenSessions.has(row.session_id)) continue;
      seenSessions.add(row.session_id);
      const session = await runtime.sessionApplication.getSession(row.session_id);
      if (!session || session.team_snapshot?.team_name !== teamName) continue; // 存量未锚定会话无法归队，跳过
      sessionIds.push(row.session_id);
      sessionRevisions.set(row.session_id, session.team_snapshot?.team_revision ?? null);
      if (sessionIds.length >= MAX_SESSIONS_PER_TEAM) break;
    }
    const sessionsTruncated = sessionIds.length >= MAX_SESSIONS_PER_TEAM;

    const samples: TeamFailureSample[] = [];
    for (const sessionId of sessionIds) {
      const [snapshot, runs] = await Promise.all([
        runtime.sessionApplication.listMessages({ sessionId, limit: MESSAGES_PER_SESSION }),
        runtime.sessionApplication.listRuns(sessionId, RUNS_PER_SESSION),
      ]);
      const messages = [...(snapshot?.items ?? [])].sort((left, right) => left.seq - right.seq);
      const sessionFeedback = feedback.filter((row) => row.session_id === sessionId);
      const snapshotRevision = sessionRevisions.get(sessionId) ?? null;
      for (const row of sessionFeedback) {
        samples.push(buildSample(
          row,
          sessionId,
          snapshotRevision,
          snapshotRevision == null ? null : revisionByHash.get(snapshotRevision) ?? null,
          messages,
          runs,
        ));
      }
    }
    samples.sort((left, right) => right.rated_at.localeCompare(left.rated_at));

    return {
      team_name: teamName,
      team_exists: true,
      collected_at: collectedAt,
      tenant_rows_scanned: feedback.length,
      has_more: hasMore,
      sessions_matched: sessionIds.length,
      sessions_truncated: sessionsTruncated,
      revision_links: teamLinks.map((link) => ({
        revision: link.revision,
        team_revision_hash: link.team_revision_hash,
        published_at: link.published_at,
      })),
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
}

function buildSample(
  row: MessageFeedback,
  sessionId: string,
  teamRevision: string | null,
  publishedRevision: number | null,
  messages: readonly TrialMessageLike[],
  runs: readonly RunInfo[],
): TeamFailureSample {
  const ratedIndex = messages.findIndex((message) => message.id === row.message_id);
  const rated = ratedIndex >= 0 ? messages[ratedIndex] : null;

  let userExcerpt: string | null = null;
  let entryOwnTextChars = 0;
  if (rated) {
    for (let index = ratedIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "user") continue;
      userExcerpt = excerpt(plainTextOf(message.content_parts), USER_EXCERPT_CHARS);
      break;
    }
    // 交互窗口 = 用户消息（含）到被踩回答（含）。可见消息不含委派中间轮
    // （react_intermediate 被持久层排除），入口自产文本只统计可见的根 assistant 消息
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
      if (!message || message.role !== "assistant" || message.child_agent_id != null) continue;
      entryOwnTextChars += plainTextOf(message.content_parts).length;
    }
  }

  // 委派形态从 run 树推导：被踩消息的根 run 的直接子 run 就是本轮委派。
  // 转写里看不到委派调用（中间轮不可见），不能按 tool_calls 统计。
  const ratedRun = rated
    ? runs.find((run) => run.final_message_id === row.message_id) ?? null
    : null;
  const childRuns = ratedRun
    ? runs.filter((run) => run.parent_run_id === ratedRun.run_id && run.child_agent_id != null)
    : [];
  const delegateCalls = childRuns.length;
  const childAgents = [...new Set(
    childRuns.map((run) => run.agent_name).filter((name): name is string => name != null),
  )].slice(0, 10);

  return {
    session_id: sessionId,
    message_id: row.message_id,
    rated_at: row.updated_at,
    comment: row.comment ?? null,
    user_excerpt: userExcerpt,
    answer_excerpt: rated ? excerpt(plainTextOf(rated.content_parts), ANSWER_EXCERPT_CHARS) : null,
    answered_by: ratedRun?.agent_name ?? null,
    run: {
      status: ratedRun?.status ?? null,
      terminal_reason: ratedRun?.terminal_reason ?? null,
      task_summary: ratedRun?.task_summary ?? null,
    },
    /** 根 run 是否匹配到：false 时委派形态不可用（消息/ run 超出扫描窗口或已删除）。 */
    run_linked: ratedRun != null,
    team_revision: teamRevision,
    published_revision: publishedRevision,
    delegate_calls: delegateCalls,
    entry_own_text_chars: entryOwnTextChars,
    child_agents: childAgents,
    entry_router_only: ratedRun != null && delegateCalls > 0 && entryOwnTextChars < ROOT_ROUTER_TEXT_THRESHOLD,
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
  if (trimmed.length <= maxChars) return trimmed;
  // 按码点截断，避免切断代理对产出 U+FFFD
  return `${[...trimmed].slice(0, maxChars).join("")}…`;
}

/** 用户可控内容（输入/回答/备注）统一引用块输出：防止内容伪造 Markdown 协议文本。 */
function quoted(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

/** 证据文件正文：Builder 用 read_file 消费，人也能直接读。 */
export function renderTeamFailureMarkdown(report: TeamFailureReport): string {
  if (!report.team_exists) {
    return [
      `# 团队失败证据：${report.team_name}`,
      "",
      `采集时间：${report.collected_at}。团队不存在于当前租户的 Team 注册表（注意用发布后的团队名，不是草稿名）。未扫描反馈，未写入证据文件。`,
      "",
    ].join("\n");
  }
  const lines: string[] = [
    `# 团队失败证据：${report.team_name}`,
    "",
    `采集时间：${report.collected_at}；扫描租户级 👎 ${report.tenant_rows_scanned} 条（含其他团队，按更新时间倒序），命中会话 ${report.sessions_matched} 个，样本 ${report.samples.length} 条。${report.has_more ? "注意：行数已达扫描上限，可能还有更早点踩未包含——需要时调大 feedback_limit 或用 since 分段回溯。" : ""}${report.sessions_truncated ? ` 命中会话数达上限 ${MAX_SESSIONS_PER_TEAM}，更早会话的样本未包含。` : ""}`,
    "",
  ];
  if (report.revision_links.length > 0) {
    lines.push("发布版本对照（会话快照哈希 → 发布 revision）：");
    for (const link of report.revision_links) {
      lines.push(`- revision ${link.revision} → ${shortHash(link.team_revision_hash)}${link.published_at ? `（发布于 ${link.published_at}）` : ""}`);
    }
    lines.push("");
  }
  if (report.samples.length === 0) {
    lines.push("该团队暂无被踩样本。没有失败证据时不要臆造教训，按域探索结论设计即可。");
    return `${lines.join("\n")}\n`;
  }
  // 未映射要区分两种成因：从未登记过哈希（归因字段启用前的发布）vs 登记过但快照对不上（团队被直接改过）
  const unmappedNote = report.revision_links.length === 0
    ? "该团队的发布均早于哈希登记（未记录内容哈希，无法归因；下一次发布会开始记录）"
    : "未映射到任何 Builder 发布版本（团队可能被直接修改过）";
  report.samples.forEach((sample, index) => {
    lines.push(`## 样本 ${index + 1}（${sample.rated_at}，session ${sample.session_id}）`);
    lines.push(`- 用户输入：${sample.user_excerpt != null ? `\n${quoted(sample.user_excerpt)}` : `（未在最近 ${MESSAGES_PER_SESSION} 条转写中找到——消息可能更早或已被编辑/删除）`}`);
    lines.push(`- 被踩回答（by ${sample.answered_by ?? "unknown"}）：${sample.answer_excerpt != null ? `\n${quoted(sample.answer_excerpt)}` : "（消息未在转写窗口内或已删除）"}`);
    lines.push(`- 运行状态：${sample.run.status ?? "unknown（run 可能超出扫描窗口或已删除）"}${sample.run.terminal_reason ? ` / ${sample.run.terminal_reason}` : ""}${sample.run.task_summary ? ` — ${sample.run.task_summary}` : ""}`);
    lines.push(`- 团队版本：${sample.published_revision != null ? `发布 revision ${sample.published_revision}` : unmappedNote}（快照 ${sample.team_revision ? shortHash(sample.team_revision) : "unknown"}）`);
    if (sample.run_linked) {
      lines.push(`- 委派形态（按 run 树）：本轮子 run ${sample.delegate_calls} 个，入口自产文本 ${sample.entry_own_text_chars} 字符${sample.child_agents.length > 0 ? `，子 Agent：${sample.child_agents.join("、")}` : ""}`);
    } else {
      lines.push("- 委派形态：本轮 run 未匹配，委派观察不可用。");
    }
    if (sample.entry_router_only) {
      lines.push("- ⚠️ 入口疑似纯路由：发生了委派但入口几乎不产出内容，按团队设计规范重新划分入口职责。");
    }
    if (sample.comment) lines.push(`- 用户备注：\n${quoted(sample.comment)}`);
    lines.push("");
  });
  lines.push("消费方式：失败样本与域探索同级作为先验。把可复现的失败输入登记为 acceptance 用例（source: regression，注明发现的发布 revision）；把形态性教训（路由化、答非所问、委派过深）写进对应 Agent 的 instructions；不要把单条偶发故障当成架构结论。");
  return `${lines.join("\n")}\n`;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

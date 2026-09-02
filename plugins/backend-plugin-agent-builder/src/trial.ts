import { randomUUID } from "node:crypto";

import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import { LOCAL_USER_ID } from "@ragsystem/backend-core/services/identity/local-identity.js";
import type { SessionTeamSnapshot } from "@ragsystem/backend-core/contracts/session/session.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { AgentExecuteResult, ExecuteRequest } from "@ragsystem/backend-core/contracts/execution/execution.js";
import type { UserId } from "@ragsystem/backend-core/identity/types.js";

import type { AgentBlueprint } from "./contracts.js";
import { validateBlueprint, toRuntimeAgent, type AgentBuilderBindings, type AgentBuilderService } from "./service.js";

/** 单次试运行的输入上限：每次工具调用都是真实模型调用，必须限流防止成本失控。 */
export const MAX_TRIAL_INPUTS_PER_CALL = 5;

export interface DraftTrialInput {
  case: string;
  expect_contains?: string[];
}

export interface DraftTrialCaseResult {
  input: string;
  status: "completed" | "suspended" | "failed" | "skipped";
  answer: string | null;
  matched: string[];
  missed: string[];
  delegated_agents: string[];
  execution_time_ms: number | null;
  error: string | null;
  /** status=skipped 时的原因（连续相同错误短路），其余状态为 null。 */
  skipped_reason: string | null;
}

export interface DraftTrialReport {
  staging_team: string;
  /** 试运行所基于的草稿 revision（manifest 乐观锁口径），供结果追溯。 */
  revision: number;
  results: DraftTrialCaseResult[];
  inputs_truncated: boolean;
  /** 被截断丢弃的输入文本（默认 acceptance 超上限时），供调用方确认丢弃了什么。 */
  truncated_inputs: string[];
  summary: {
    total: number;
    completed: number;
    suspended: number;
    failed: number;
    skipped: number;
    all_expectations_met: boolean;
  };
}

export interface DraftTrialDependencies {
  readonly service: AgentBuilderService;
  readonly registry: RuntimeContainerRegistry;
  readonly tenantId: string;
  readonly userId?: string;
  readonly bindings: AgentBuilderBindings;
}

/**
 * 试用运行（练车场，非门禁）：把工作区当前蓝图物化到一次性暂存 Team，
 * 对每条输入做一次无头端到端运行，带回观察记录（回答、期望片段命中、委派了哪些子
 * Agent），然后删除暂存 Team 与试用会话。报告供 Builder 自检自改与人工审查消费。
 */
export async function runDraftTrial(
  deps: DraftTrialDependencies,
  draftId: string,
  workspaceRoot: string,
  inputs?: readonly DraftTrialInput[] | null,
): Promise<DraftTrialReport> {
  const { blueprint, revision } = await deps.service.readWorkspaceBlueprint(draftId, workspaceRoot);
  const userId = (deps.userId?.trim() || LOCAL_USER_ID) as UserId;
  const validation = validateBlueprint(blueprint, deps.bindings.inventory);
  if (!validation.valid) {
    // 结构不合法的蓝图不物化：先让 Builder 修完 error 再来试（warning 不阻止试运行）
    throw new Error(`蓝图校验未通过，先修复 error 再试运行：${validation.issues
      .filter((issue) => issue.level === "error")
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ")}`);
  }

  const requested = inputs && inputs.length > 0
    ? [...inputs]
    : blueprint.acceptance.map((item) => ({ case: item.case, expect_contains: [...item.expect_contains] }));
  if (requested.length === 0) {
    throw new Error("没有可运行的输入：请传入 inputs，或在蓝图 acceptance 里登记验收用例");
  }
  if (inputs && inputs.length > MAX_TRIAL_INPUTS_PER_CALL) {
    // 显式超限直接拒绝而不是静默截断：调用方明确想跑的样本被丢弃只会造成误判。
    // 默认走 acceptance 超限时才截断（truncated_inputs 会列出被丢弃的样本）。
    throw new Error(`inputs 一次最多 ${MAX_TRIAL_INPUTS_PER_CALL} 条（收到 ${inputs.length} 条），更多样本请分批调用`);
  }
  const batch = requested.slice(0, MAX_TRIAL_INPUTS_PER_CALL);
  const truncatedInputs = requested.slice(MAX_TRIAL_INPUTS_PER_CALL).map((item) => item.case);

  // 与 publish 物化同一入口回填 provider_type：蓝图省略它时运行时 readiness 必挂，
  // 试运行必须跑在与发布完全一致的物化结果上，否则试过 ≠ 能跑。
  const materialized = deps.service.expandBlueprintLlmTiers(blueprint);
  const agentConfig = deps.service.getAgentConfigPort();
  const stagingTeam = await allocateStagingTeamName(async () => agentConfig.listTeams(), blueprint);
  const results: DraftTrialCaseResult[] = [];
  const lease = await deps.registry.acquire(deps.tenantId);
  try {
    await agentConfig.applyTeamPayload(
      stagingTeam,
      Object.fromEntries(materialized.agents.map((agent) => [
        agent.name,
        toRuntimeAgent(agent, agent.name === materialized.entry_agent),
      ])),
    );
    for (const agent of materialized.agents) {
      for (const provider of deps.bindings.providers) {
        await provider.putAgentConfig(stagingTeam, agent.name, agent.capabilities[provider.id] ?? []);
      }
    }

    const runtime = lease.runtime;
    const teamSnapshot = runtime.agentConfig.createTeamSnapshot({
      teamName: stagingTeam,
      entryAgentName: materialized.entry_agent,
    });
    // 连续两条相同错误即判定为配置级故障（换输入也不会变），短路剩余输入：
    // 每条输入都是真实模型调用，重复烧钱买同一份报错没有观察价值。
    let previousError: string | null = null;
    let shortCircuitReason: string | null = null;
    for (const [index, input] of batch.entries()) {
      if (shortCircuitReason) {
        results.push({
          input: input.case,
          status: "skipped",
          answer: null,
          matched: [],
          missed: [...(input.expect_contains ?? [])],
          delegated_agents: [],
          execution_time_ms: null,
          error: null,
          skipped_reason: shortCircuitReason,
        });
        continue;
      }
      const sessionId = `agent-builder-trial-${stagingTeam}-${index}-${randomUUID().slice(0, 8)}`;
      // 单输入容错：一条输入的基础设施异常只作废该条（记 failed 行），
      // 不丢弃整份报告——前面输入的观察是真实模型调用的成果。
      let row: DraftTrialCaseResult;
      try {
        row = await runSingleTrialInput(runtime, userId, {
          sessionId,
          teamSnapshot,
          entryAgent: materialized.entry_agent,
          input,
        });
      } catch (error) {
        row = {
          input: input.case,
          status: "failed",
          answer: null,
          matched: [],
          missed: [...(input.expect_contains ?? [])],
          delegated_agents: [],
          execution_time_ms: null,
          error: error instanceof Error ? error.message : String(error),
          skipped_reason: null,
        };
      }
      results.push(row);
      const rowError = row.status === "failed" ? row.error : null;
      if (rowError && rowError === previousError) {
        shortCircuitReason = `连续两条输入报相同错误：${rowError}`;
      }
      previousError = rowError;
    }
  } finally {
    // 清理与物化对称：先清 provider 能力绑定再删 Team；删除失败不掩盖运行期错误
    try {
      for (const agent of blueprint.agents) {
        for (const provider of deps.bindings.providers) {
          await provider.putAgentConfig(stagingTeam, agent.name, []);
        }
      }
    } catch { /* 尽力清理 */ }
    try {
      await agentConfig.deleteTeam(stagingTeam);
    } catch { /* 尽力清理 */ }
    lease.release();
  }

  return {
    staging_team: stagingTeam,
    revision,
    results,
    inputs_truncated: truncatedInputs.length > 0,
    truncated_inputs: truncatedInputs,
    summary: {
      total: results.length,
      completed: results.filter((item) => item.status === "completed").length,
      suspended: results.filter((item) => item.status === "suspended").length,
      failed: results.filter((item) => item.status === "failed").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      all_expectations_met: results.every(
        (item) => item.status === "completed" && item.missed.length === 0,
      ),
    },
  };
}

/** TrialRuntime 是 RuntimeContainer 的结构性子集：显式声明依赖面，测试可伪造。 */
interface TrialRuntime {
  readonly agentConfig: {
    createTeamSnapshot(input: { teamName: string; entryAgentName?: string | null }): SessionTeamSnapshot;
  };
  readonly sessionApplication: {
    ensureSession(input: {
      sessionId: string;
      ownerUserId: string;
      visibility: "private" | "tenant";
      originType: "direct" | "bot" | "widget";
      originId: string;
      originChannel: "web" | "api" | "feishu" | "cron" | "widget_embed" | "widget_api";
      workspaceId: string | null;
      teamSnapshot: SessionTeamSnapshot;
      permissionMode?: PermissionMode | null;
    }): Promise<void>;
    deleteSession(sessionId: string): Promise<boolean>;
  };
  readonly agentExecution: {
    executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  };
  readonly agentDelegation: {
    listSessionParticipants(sessionId: string): Promise<{
      items: Array<{ participant_id: string; scope?: string; agent_name: string | null }>;
      total: number;
    } | null>;
  };
}

async function runSingleTrialInput(
  runtime: TrialRuntime,
  userId: UserId,
  options: {
    sessionId: string;
    teamSnapshot: SessionTeamSnapshot;
    entryAgent: string;
    input: DraftTrialInput;
  },
): Promise<DraftTrialCaseResult> {
  await runtime.sessionApplication.ensureSession({
    sessionId: options.sessionId,
    ownerUserId: userId,
    visibility: "private",
    originType: "bot",
    originId: "agent-builder-trial",
    originChannel: "api",
    workspaceId: null,
    teamSnapshot: options.teamSnapshot,
    permissionMode: null,
  });
  try {
    const startedAt = Date.now();
    const result = await runtime.agentExecution.executeSynchronously({
      task: options.input.case,
      session_id: options.sessionId,
      agent: options.entryAgent,
      userId,
      executionKind: "agent-builder.trial",
    }, randomUUID());
    const answer = result.answer ?? null;
    const expected = options.input.expect_contains ?? [];
    const matched = expected.filter((fragment) => answer?.includes(fragment) ?? false);
    const participants = (await runtime.agentDelegation.listSessionParticipants(options.sessionId))?.items ?? [];
    return {
      input: options.input.case,
      status: result.suspended ? "suspended" : result.success ? "completed" : "failed",
      answer,
      matched,
      missed: expected.filter((fragment) => !matched.includes(fragment)),
      delegated_agents: participants
        .filter((item) => item.scope !== "root" && item.participant_id !== "root")
        .map((item) => item.agent_name ?? item.participant_id),
      // AgentExecuteResult.execution_time 的全仓口径是秒；无头同步执行常不带它，墙钟兜底
      execution_time_ms: result.execution_time != null
        ? Math.round(result.execution_time * 1000)
        : Date.now() - startedAt,
      error: result.error ?? null,
      skipped_reason: null,
    };
  } finally {
    // 试用会话用完即删：不留在用户会话列表，报告里已带全部观察
    try { await runtime.sessionApplication.deleteSession(options.sessionId); } catch { /* 尽力清理 */ }
  }
}

/** 暂存 Team 名：staging-<蓝图名>-<随机>。名称规范不允许点号，仅用小写/数字/连字符。 */
async function allocateStagingTeamName(
  listTeams: () => Promise<{ teams: Array<{ team_name: string }> }>,
  blueprint: AgentBlueprint,
): Promise<string> {  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomUUID().slice(0, 8);
    const candidate = `staging-${blueprint.name.slice(0, 40)}-${suffix}`;
    const summary = await listTeams();
    if (!summary.teams.some((team) => team.team_name === candidate)) return candidate;
  }
  throw new Error("无法分配唯一的暂存 Team 名称，请重试");
}

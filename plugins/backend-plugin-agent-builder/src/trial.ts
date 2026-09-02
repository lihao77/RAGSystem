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
  status: "completed" | "suspended" | "failed";
  answer: string | null;
  matched: string[];
  missed: string[];
  delegated_agents: string[];
  execution_time_ms: number | null;
  error: string | null;
}

export interface DraftTrialReport {
  staging_team: string;
  /** 试运行所基于的草稿 revision（manifest 乐观锁口径），供结果追溯。 */
  revision: number;
  results: DraftTrialCaseResult[];
  inputs_truncated: boolean;
  summary: {
    total: number;
    completed: number;
    suspended: number;
    failed: number;
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
  const inputsTruncated = requested.length > MAX_TRIAL_INPUTS_PER_CALL;
  const batch = requested.slice(0, MAX_TRIAL_INPUTS_PER_CALL);

  const agentConfig = deps.service.getAgentConfigPort();
  const stagingTeam = await allocateStagingTeamName(async () => agentConfig.listTeams(), blueprint);
  const results: DraftTrialCaseResult[] = [];
  const lease = await deps.registry.acquire(deps.tenantId);
  try {
    await agentConfig.applyTeamPayload(
      stagingTeam,
      Object.fromEntries(blueprint.agents.map((agent) => [
        agent.name,
        toRuntimeAgent(agent, agent.name === blueprint.entry_agent),
      ])),
    );
    for (const agent of blueprint.agents) {
      for (const provider of deps.bindings.providers) {
        await provider.putAgentConfig(stagingTeam, agent.name, agent.capabilities[provider.id] ?? []);
      }
    }

    const runtime = lease.runtime;
    const teamSnapshot = runtime.agentConfig.createTeamSnapshot({
      teamName: stagingTeam,
      entryAgentName: blueprint.entry_agent,
    });
    for (const [index, input] of batch.entries()) {
      const sessionId = `agent-builder-trial-${stagingTeam}-${index}-${randomUUID().slice(0, 8)}`;
      // 单输入容错：一条输入的基础设施异常只作废该条（记 failed 行），
      // 不丢弃整份报告——前面输入的观察是真实模型调用的成果。
      try {
        results.push(await runSingleTrialInput(runtime, userId, {
          sessionId,
          teamSnapshot,
          entryAgent: blueprint.entry_agent,
          input,
        }));
      } catch (error) {
        results.push({
          input: input.case,
          status: "failed",
          answer: null,
          matched: [],
          missed: [...(input.expect_contains ?? [])],
          delegated_agents: [],
          execution_time_ms: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
    inputs_truncated: inputsTruncated,
    summary: {
      total: results.length,
      completed: results.filter((item) => item.status === "completed").length,
      suspended: results.filter((item) => item.status === "suspended").length,
      failed: results.filter((item) => item.status === "failed").length,
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
      // AgentExecuteResult.execution_time 的全仓口径是秒（message-render/formatElapsed 均按秒读），报告统一输出毫秒
      execution_time_ms: result.execution_time != null ? Math.round(result.execution_time * 1000) : null,
      error: result.error ?? null,
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

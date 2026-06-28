/**
 * 事件 Hook 系统（SDK 内核 + 工具执行生命周期）。
 *
 * 设计：类型安全的事件钩子，**支持阻断（deny）与注入（改入参/改结果/注入上下文）**。
 * - 每个事件有专属输入类型（HookInputMap）+ 专属输出类型（HookOutputMap），handler 签名按事件推导。
 * - 阻断/注入语义：tool.before 可 deny + 改入参；tool.after 可改结果；round.before 可注入上下文。
 * - 多 handler 并行语义经 registry 聚合：decision 用 deny>ask>allow，注入字段末者生效，metadata 浅合并。
 * - 策略层（permissionPolicy 端口）是兜底安全网，与 hook 协作但职责不同（后续 permission 可迁居为 tool.before handler）。
 */
import type { ToolAccessDecision } from "../tools/tool.js";
import type { KernelContext } from "../kernel-context.js";
import type {
  KernelOutcome,
  KernelResult,
  RuntimeSession,
  ToolExecutionResult,
  ToolExecContext,
} from "../contracts.js";

/** Hook 事件名，按 run / round / tool 三层分组。 */
export type HookEvent =
  // run 级
  | "run.before"
  | "run.after"
  // round 级（LLM 调用轮次）
  | "round.before"
  | "round.after"
  // tool 级
  | "tool.before"
  | "tool.gate"
  | "tool.after"
  | "tool.error";

/** run 启动前。 */
export interface RunBeforeInput {
  session: RuntimeSession;
}

/** run 结束后。 */
export interface RunAfterInput {
  session: RuntimeSession;
  result: KernelResult;
}

/** 每轮问模型前（compaction 挂这里；可注入 additionalContext）。 */
export interface RoundBeforeInput {
  ctx: KernelContext;
  round: number;
}

/** 问模型返回后。 */
export interface RoundAfterInput {
  ctx: KernelContext;
  round: number;
  outcome: KernelOutcome;
}

/** 单次工具执行前。 */
export interface ToolBeforeInput {
  toolName: string;
  arguments: Record<string, unknown>;
  ctx: ToolExecContext;
}

/** 工具门禁（tool.before 改完入参 + re-prepare 之后、执行之前）。审批策略挂这里。 */
export interface ToolGateInput {
  toolName: string;
  /** 最终入参（已应用 tool.before 的 modifiedInput 并 re-prepare）。 */
  arguments: Record<string, unknown>;
  ctx: ToolExecContext;
  /** prepare 派生风险等级（Tool.riskLevel + checkAccess.riskLevel 综合，审批展示用）。 */
  riskLevel: string;
  /** 工具 checkAccess 决策（自检 + 审批声明 + 业务 signals；handler 据此调 backend 审批服务）。 */
  access: ToolAccessDecision | null;
}

/** 单次工具执行后。 */
export interface ToolAfterInput {
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
  ctx: ToolExecContext;
}

/** 单次工具执行异常。 */
export interface ToolErrorInput {
  toolName: string;
  arguments: Record<string, unknown>;
  error: unknown;
  ctx: ToolExecContext;
}

/** 事件 → 输入类型映射。 */
export interface HookInputMap {
  "run.before": RunBeforeInput;
  "run.after": RunAfterInput;
  "round.before": RoundBeforeInput;
  "round.after": RoundAfterInput;
  "tool.before": ToolBeforeInput;
  "tool.gate": ToolGateInput;
  "tool.after": ToolAfterInput;
  "tool.error": ToolErrorInput;
}

// ────────────────────────────── 输出类型（阻断 + 注入） ──────────────────────────────

/** 所有 hook 输出的公共字段：附加元数据（多 handler 浅合并）。 */
export interface BaseHookOutput {
  metadata?: Record<string, unknown>;
}

/** 阻断决策。多 handler 聚合：deny>allow（ask 由 gate handler 内部消化成 allow/deny，不外泄）。 */
export type HookDecision = "allow" | "deny";

export interface DecisionFields {
  /** allow=放行 / deny=拒绝（跳过工具）。多 handler 聚合：deny>allow。 */
  decision?: HookDecision;
  /** 决策理由（随决策一起取自同一 handler）。 */
  reason?: string;
}

/** tool.before 输出：可 deny + 改入参。 */
export interface ToolBeforeOutput extends BaseHookOutput, DecisionFields {
  /** 改写工具入参（registry 聚合后由执行器 re-prepare 校验再执行）；多 handler 末者生效。 */
  modifiedInput?: Record<string, unknown>;
}

/** tool.gate 输出：审批门禁最终入参。handler 内部消化审批交互，返回 allow/deny；多 handler 聚合 deny>allow。 */
export interface ToolGateOutput extends BaseHookOutput, DecisionFields {}

/** tool.after 输出：可改写工具结果。 */
export interface ToolAfterOutput extends BaseHookOutput {
  /** 替换工具执行结果（喂给模型的 observation）；多 handler 末者生效。 */
  modifiedResult?: ToolExecutionResult;
}

/** round.before 输出：可注入本轮上下文。 */
export interface RoundBeforeOutput extends BaseHookOutput {
  /** 追加到本轮请求消息的附加上下文（system 级）；多 handler 末者生效。 */
  additionalContext?: string;
}

/** 事件 → 输出类型映射。通知型事件（run.* / round.after / tool.error）仅 metadata。 */
export interface HookOutputMap {
  "run.before": BaseHookOutput;
  "run.after": BaseHookOutput;
  "round.before": RoundBeforeOutput;
  "round.after": BaseHookOutput;
  "tool.before": ToolBeforeOutput;
  "tool.gate": ToolGateOutput;
  "tool.after": ToolAfterOutput;
  "tool.error": BaseHookOutput;
}

/** 空 HookOutput。 */
export const EMPTY_HOOK_OUTPUT: Readonly<BaseHookOutput> = Object.freeze({});

/** 单个事件的 handler 类型——按事件推导输入与输出。 */
export type HookHandler<E extends HookEvent> = (
  input: HookInputMap[E],
) => HookOutputMap[E] | void | Promise<HookOutputMap[E] | void>;

/** Hook 注册表：on 注册（返回 unsubscribe），emit 顺序执行并聚合输出。 */
export interface HookRegistry {
  /** 注册 handler，返回反注册函数。 */
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void;
  /** 触发某事件，顺序 await 所有 handler，聚合输出（deny>ask>allow；注入末者生效；metadata 浅合并）。单个 handler 异常不阻断其余。 */
  emit<E extends HookEvent>(event: E, input: HookInputMap[E]): Promise<HookOutputMap[E]>;
}

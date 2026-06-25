/**
 * 事件 Hook 系统（SDK 内核 + 工具执行生命周期）。
 *
 * 设计目标：类型安全的事件钩子，纯通知 + 注入，不做阻断/权限决策。
 * - 每个事件有专属的输入类型（HookInputMap），handler 参数按事件自动推导。
 * - HookOutput 只提供 additionalContext（上下文注入）+ metadata（元数据合并），无 block/permission。
 * - 策略判定（审批/拦截）归策略层，不经 hook。
 */
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

/** 每轮问模型前（compaction 挂这里）。 */
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
  "tool.after": ToolAfterInput;
  "tool.error": ToolErrorInput;
}

/** Hook 返回值：纯注入，无阻断/权限。 */
export interface HookOutput {
  /** 附加元数据（打标签/审计/进度），多个 handler 的输出浅合并。 */
  metadata?: Record<string, unknown>;
}

/** 空 HookOutput。 */
export const EMPTY_HOOK_OUTPUT: Readonly<HookOutput> = Object.freeze({});

/** 单个事件的 handler 类型——按事件推导输入。 */
export type HookHandler<E extends HookEvent> = (
  input: HookInputMap[E],
) => HookOutput | void | Promise<HookOutput | void>;

/** Hook 注册表：on 注册（返回 unsubscribe），emit 顺序执行并合并输出。 */
export interface HookRegistry {
  /** 注册 handler，返回反注册函数。 */
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void;
  /** 触发某事件，顺序 await 所有 handler，合并输出。单个 handler 异常不阻断其余。 */
  emit<E extends HookEvent>(event: E, input: HookInputMap[E]): Promise<HookOutput>;
}

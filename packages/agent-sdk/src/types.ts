/**
 * AgentProfile —— 调用方投影后传入的核心配置子集（设计稿 §3）。
 *
 * backend-ts 的 AgentConfig 混了核心字段与衍生字段。SDK 取核心子集。投影层（backend-ts 侧）
 * 负责把 agent.llm_tiers 解析成全量已决的 ResolvedTier 表、selectLlm 替换 default、字段回落算死。
 * SDK 内核零兜底，只读这些已决值。
 */
import type { ProviderConfig } from "@ragsystem/agent-llm";

/**
 * 全量已决的 tier 档：provider 已内联（非引用字符串）、参数已填、缺档已补齐。
 *
 * 投影是唯一解析点（设计稿 §3 契约约束）：provider 引用解析、selectLlm 替换 default、
 * 字段回落（tier → default → system）、extra_params merge 全在投影层算死。内核只按 tier 名索引取值。
 */
export interface ResolvedTier {
  /** 已解析的完整 provider（非引用字符串）。 */
  provider: ProviderConfig;
  modelName: string;
  temperature: number | null;
  maxCompletionTokens: number | null;
  /** 上下文窗口 token 上限（provider 最大上下文）；投影算死。 */
  maxContextTokens: number | null;
  /** extra_params merge 完。 */
  extraParams: Record<string, unknown>;
}

/** tier 名 → 已决档。至少含 default（tier 解析的最后一道真相）。 */
export type TierMap = Record<string, ResolvedTier>;

/** 压缩预算配置（默认参数内置，投影可选覆盖，设计稿 §9）。 */
export interface CompressionBudgetConfig {
  /** 上下文窗口安全系数，默认 0.9。 */
  contextWindowSafetyFactor: number;
  /** system prompt 预留，默认 2000。 */
  systemPromptReserve: number;
  /** 最小上下文预算下限，默认 4000。 */
  minContextBudget: number;
}

export const DEFAULT_COMPRESSION_BUDGET: CompressionBudgetConfig = {
  contextWindowSafetyFactor: 0.9,
  systemPromptReserve: 2000,
  minContextBudget: 4000,
};

/** agent 行为配置（投影自 AgentConfig.custom_params.behavior）。 */
export interface AgentBehavior {
  systemPrompt: string;
  compressionTriggerRatio: number | null;
  summarizeMaxTokens: number | null;
  preserveRecentTurns: number | null;
  /** 压缩预算配置；不传用 DEFAULT_COMPRESSION_BUDGET。 */
  budget?: CompressionBudgetConfig;
}

/** memory 配置（投影自 AgentConfig.memory）。 */
export interface MemoryConfig {
  autoInject: boolean;
  allowedScopes: readonly string[];
  writeScopes: readonly string[];
  archiveScopes: readonly string[];
}

/**
 * AgentProfile —— AgentConfig 的核心投影（设计稿 §3）。
 *
 * 调用方投影后传入。衍生字段（tools/skills/mcp/knowledge_base/delegation/审批/outbox）不进。
 */
export interface AgentProfile {
  agentName: string;
 displayName: string | null;
 /** 全量已决的扁平 tier 表（投影算死，内核零兜底）。 */
  llmTiers: TierMap;
  memory: MemoryConfig;
  behavior: AgentBehavior;
  /** custom_params 其余透传。 */
  customParams?: Record<string, unknown>;
}

/** run 终态。 */
export type RunStatus = "completed" | "failed" | "interrupted";

/** 消息角色（对齐 backend-ts MessageInfo.role）。 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 结构化工具调用（跨协议统一）。 */
export interface ToolCallRef {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 消息记录（对齐 backend-ts MessageInfo 形状）。 */
export interface MessageInfo {
  id: string;
  seq: number;
 sessionId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  threadKey: string;
  childAgentId: string | null;
  toolCalls?: ToolCallRef[];
  toolCallId?: string;
  name?: string;
}

/** run_step 记录（对齐 backend-ts run_step 形状）。 */
export interface RunStepRecord {
  id: string;
  sessionId: string;
  runId: string;
  stepType: string;
  payload: Record<string, unknown>;
  messageId: string | null;
  createdAt: string;
}

/** run 记录。 */
export interface RunRecord {
  id: string;
  sessionId: string;
  status: RunStatus;
  rootCallId: string;
  threadKey: string;
  parentCallId: string | null;
  finalMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

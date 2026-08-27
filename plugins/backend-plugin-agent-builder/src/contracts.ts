import { z } from "zod";

import { AgentLlmConfigSchema } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

const IdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must use lower-case letters, digits, underscores, or hyphens");

export const AgentBlueprintAgentSchema = z.object({
  name: IdentifierSchema,
  display_name: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional().default(""),
  instructions: z.string().trim().min(1).max(30_000),
  enabled: z.boolean().optional().default(true),
  llm: AgentLlmConfigSchema.nullable().optional(),
  llm_tiers: z.record(AgentLlmConfigSchema).nullable().optional(),
  tools: z.array(z.string().trim().min(1)).max(100).optional().default([]),
  capabilities: z.record(z.array(z.string().trim().min(1)).max(100)).optional().default({}),
  delegates: z.array(IdentifierSchema).max(20).optional().default([]),
  goals_enabled: z.boolean().optional().default(false),
  background_tasks: z.boolean().optional().default(false),
  custom_params: z.record(z.unknown()).optional().default({}),
}).strict();

export const AgentBlueprintSchema = z.object({
  schema_version: z.literal(2),
  name: IdentifierSchema,
  description: z.string().trim().min(1).max(1_000),
  entry_agent: IdentifierSchema,
  agents: z.array(AgentBlueprintAgentSchema).min(1).max(20),
}).strict().superRefine((blueprint, context) => {
  const seen = new Set<string>();
  for (const [index, agent] of blueprint.agents.entries()) {
    if (seen.has(agent.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", index, "name"],
        message: `duplicate agent '${agent.name}'`,
      });
    }
    seen.add(agent.name);
  }
});

export const AgentBuilderValidationIssueSchema = z.object({
  level: z.enum(["error", "warning"]),
  code: z.string(),
  path: z.string(),
  message: z.string(),
}).strict();

export const AgentBuilderValidationReportSchema = z.object({
  valid: z.boolean(),
  checked_at: z.string().datetime(),
  issues: z.array(AgentBuilderValidationIssueSchema),
}).strict();

export const AgentDraftStatusSchema = z.enum([
  "draft",
  "published",
]);

export const AgentDraftSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: AgentDraftStatusSchema,
  source_team_name: z.string().trim().min(1).nullable().default(null),
  blueprint: AgentBlueprintSchema,
  validation: AgentBuilderValidationReportSchema.nullable(),
  published_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export const CreateAgentDraftRequestSchema = z.object({
  blueprint: z.unknown(),
}).strict();

export const UpdateAgentDraftRequestSchema = z.object({
  expected_revision: z.number().int().positive(),
  blueprint: z.unknown(),
}).strict();

export const PublishAgentDraftRequestSchema = z.object({
  expected_revision: z.number().int().positive(),
}).strict();

export const RollbackAgentDraftRequestSchema = z.object({
  expected_revision: z.number().int().positive(),
  to_revision: z.number().int().positive(),
}).strict();

export type AgentBlueprint = z.infer<typeof AgentBlueprintSchema>;
export type AgentBlueprintAgent = z.infer<typeof AgentBlueprintAgentSchema>;
export type AgentBuilderValidationIssue = z.infer<typeof AgentBuilderValidationIssueSchema>;
export type AgentBuilderValidationReport = z.infer<typeof AgentBuilderValidationReportSchema>;
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export interface AgentBuilderLlmProviderInfo {
  readonly provider_type: string;
  readonly models: readonly string[];
}

export interface AgentBuilderCapabilityInventory {
  readonly tools?: ReadonlySet<string>;
  /** 提供方 id → 可用能力名集合；缺失的提供方跳过校验（与插件未安装语义一致）。 */
  readonly providers?: ReadonlyMap<string, ReadonlySet<string>>;
  /** provider 名 → 模型目录；缺失时跳过 llm_tiers.provider 校验（与模型适配层不可用语义一致）。 */
  readonly llm_providers?: ReadonlyMap<string, AgentBuilderLlmProviderInfo>;
}

/**
 * 将 schema v1 蓝图（agents[].skills / agents[].mcp_servers 独立字段）归一化为
 * v2 的 capabilities 映射（skills→"skills"、mcp_servers→"mcp"）；
 * 已存在的 capabilities 键优先，不被同名旧字段覆盖。v2 输入原样通过。
 */
export function normalizeLegacyBlueprint(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.agents)) return value;
  return {
    ...value,
    schema_version: 2,
    agents: value.agents.map((agent) => {
      if (!isRecord(agent)) return agent;
      const { skills, mcp_servers, ...rest } = agent;
      const capabilities = isRecord(agent.capabilities) ? { ...agent.capabilities } : {};
      if (Array.isArray(skills) && capabilities.skills === undefined) capabilities.skills = skills;
      if (Array.isArray(mcp_servers) && capabilities.mcp === undefined) capabilities.mcp = mcp_servers;
      return { ...rest, capabilities };
    }),
  };
}

/** 全部蓝图入口的统一解析口：先归一化旧格式，再执行 v2 strict 校验。 */
export function parseBlueprint(value: unknown): AgentBlueprint {
  return AgentBlueprintSchema.parse(normalizeLegacyBlueprint(value));
}

/** 草稿文件/API 载荷的统一解析口（含蓝图归一化）。 */
export function parseAgentDraft(value: unknown): AgentDraft {
  return AgentDraftSchema.parse(
    isRecord(value) && value.blueprint !== undefined
      ? { ...value, blueprint: normalizeLegacyBlueprint(value.blueprint) }
      : value,
  );
}

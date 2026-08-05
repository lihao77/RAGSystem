import { z } from "zod";

import { AgentLlmConfigSchema } from "@ragsystem/backend-core/contracts/agent/agent-config.js";

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
  skills: z.array(z.string().trim().min(1)).max(100).optional().default([]),
  mcp_servers: z.array(z.string().trim().min(1)).max(100).optional().default([]),
  delegates: z.array(IdentifierSchema).max(20).optional().default([]),
  goals_enabled: z.boolean().optional().default(false),
  background_tasks: z.boolean().optional().default(false),
  custom_params: z.record(z.unknown()).optional().default({}),
}).strict();

export const AgentBlueprintSchema = z.object({
  schema_version: z.literal(1),
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
  blueprint: AgentBlueprintSchema,
}).strict();

export const UpdateAgentDraftRequestSchema = z.object({
  expected_revision: z.number().int().positive(),
  blueprint: AgentBlueprintSchema,
}).strict();

export const PublishAgentDraftRequestSchema = z.object({
  expected_revision: z.number().int().positive(),
}).strict();

export type AgentBlueprint = z.infer<typeof AgentBlueprintSchema>;
export type AgentBlueprintAgent = z.infer<typeof AgentBlueprintAgentSchema>;
export type AgentBuilderValidationIssue = z.infer<typeof AgentBuilderValidationIssueSchema>;
export type AgentBuilderValidationReport = z.infer<typeof AgentBuilderValidationReportSchema>;
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export interface AgentBuilderCapabilityInventory {
  readonly tools?: ReadonlySet<string>;
  readonly skills?: ReadonlySet<string>;
  readonly mcpServers?: ReadonlySet<string>;
}

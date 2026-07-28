import { z } from "zod";

export const AgentLlmConfigSchema = z.object({
  provider: z.string().nullable().optional(),
  provider_type: z.string().nullable().optional(),
  model_name: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  max_context_tokens: z.number().int().positive().nullable().optional(),
  extra_params: z.record(z.unknown()).optional().default({}),
});

const AgentConfigObjectSchema = z.object({
  agent_name: z.string().min(1),
  display_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional().default(true),
  default_entry: z.boolean().optional().default(false),
  llm_tiers: z.record(AgentLlmConfigSchema).nullable().optional(),
  tools: z.object({ enabled_tools: z.array(z.string()).optional().default([]) }).optional().default({ enabled_tools: [] }),
  goals: z
    .object({
      enabled: z.boolean().optional().default(false),
    })
    .optional()
    .default({ enabled: false }),
  tasks: z
    .object({
      background: z.boolean().optional().default(false),
    })
    .optional()
    .default({ background: false }),
  delegation: z
    .object({ enabled_agents: z.array(z.string()).optional().default([]) })
    .optional()
    .default({ enabled_agents: [] }),
  custom_params: z.record(z.unknown()).optional().default({}),
});

/** Preserve the old workflow capability when reading pre-Goal agent configs. */
export const AgentConfigSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  if (config.goals !== undefined) return value;
  const tasks = config.tasks;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return value;
  const workflow = (tasks as Record<string, unknown>).workflow;
  if (typeof workflow !== "boolean") return value;
  return { ...config, goals: { enabled: workflow } };
}, AgentConfigObjectSchema);

export const CreateTeamRequestSchema = z.object({
  team_name: z.string().min(1),
  source_team: z.string().nullable().optional(),
});

export const RenameTeamRequestSchema = z.object({
  new_team_name: z.string().min(1),
});

export const CopyAgentsRequestSchema = z.object({
  source_team: z.string().min(1),
  agent_names: z.array(z.string()).optional().default([]),
});

export const CreateAgentRequestSchema = z.object({
  agent_name: z.string().min(1),
  display_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  default_entry: z.boolean().optional().default(false),
  custom_params: z.record(z.unknown()).nullable().optional(),
  llm: AgentLlmConfigSchema.nullable().optional(),
});

export const ApplyPresetRequestSchema = z.object({
  preset: z.string().min(1),
});

export type AgentLlmConfig = z.infer<typeof AgentLlmConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;
export type RenameTeamRequest = z.infer<typeof RenameTeamRequestSchema>;
export type CopyAgentsRequest = z.infer<typeof CopyAgentsRequestSchema>;
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type ApplyPresetRequest = z.infer<typeof ApplyPresetRequestSchema>;

export interface TeamInfo {
  team_name: string;
  file_path: string;
  is_active: boolean;
  agent_count: number;
  agents: string[];
}

export interface TeamSummary {
  active_team: string;
  teams: TeamInfo[];
}

export interface AgentInfo {
  name: string;
  agent_name: string;
  display_name: string | null;
  description: string | null;
  capabilities: string[];
  tools: string[];
  enabled: boolean;
  default_entry: boolean;
  config: {
    enabled: boolean;
    llm_tiers?: Record<string, AgentLlmConfig> | null;
    custom_params: Record<string, unknown>;
  };
}

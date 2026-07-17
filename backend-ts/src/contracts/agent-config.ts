import { z } from "zod";
import { MemoryScopeNameSchema } from "./memory-store/types.js";

export const AgentLlmConfigSchema = z.object({
  provider: z.string().nullable().optional(),
  provider_type: z.string().nullable().optional(),
  model_name: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  max_context_tokens: z.number().int().positive().nullable().optional(),
  extra_params: z.record(z.unknown()).optional().default({}),
});

export const AgentConfigSchema = z.object({
  agent_name: z.string().min(1),
  display_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional().default(true),
  default_entry: z.boolean().optional().default(false),
  llm_tiers: z.record(AgentLlmConfigSchema).nullable().optional(),
  tools: z.object({ enabled_tools: z.array(z.string()).optional().default([]) }).optional().default({ enabled_tools: [] }),
  skills: z
    .object({
      enabled_skills: z.array(z.string()).optional().default([]),
    })
    .optional()
    .default({ enabled_skills: [] }),
  mcp: z.object({ enabled_servers: z.array(z.string()).optional().default([]) }).optional().default({ enabled_servers: [] }),
  memory: z
    .object({
      auto_inject: z.boolean().optional().default(true),
      allowed_scopes: z.array(MemoryScopeNameSchema).optional().default(["team", "session", "user"]),
      write_scopes: z.array(MemoryScopeNameSchema).optional().default(["session", "user"]),
      archive_scopes: z.array(MemoryScopeNameSchema).optional().default(["session", "user"]),
    })
    .optional()
    .default({
      auto_inject: true,
      allowed_scopes: ["team", "session", "user"],
      write_scopes: ["session", "user"],
      archive_scopes: ["session", "user"],
    }),
  tasks: z
    .object({
      workflow: z.boolean().optional().default(false),
      background: z.boolean().optional().default(false),
    })
    .optional()
    .default({ workflow: false, background: false }),
  delegation: z
    .object({ enabled_agents: z.array(z.string()).optional().default([]) })
    .optional()
    .default({ enabled_agents: [] }),
  knowledge_base: z
    .object({
      enabled: z.boolean().optional().default(false),
      default_collection: z.string().optional().default("documents"),
      default_search_mode: z.string().optional().default("hybrid"),
      default_top_k: z.number().int().positive().optional().default(5),
      default_rerank: z.boolean().optional().default(false),
      default_reranker_key: z.string().nullable().optional().default(null),
    })
    .optional()
    .default({
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    }),
  custom_params: z.record(z.unknown()).optional().default({}),
});

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

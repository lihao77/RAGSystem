export type RuntimeCoreRequirementCategory = "agent" | "llm" | "provider" | "execution_runtime";

export interface RuntimeCoreRequirement {
  key: string;
  category: RuntimeCoreRequirementCategory;
  required: boolean;
  satisfied: boolean;
  code?: string;
  message: string;
}

export interface RuntimeCoreAgentInfo {
  agent_name: string | null;
  display_name: string | null;
  enabled: boolean;
  default_entry: boolean;
  source: "agent_config" | "missing";
}

export interface RuntimeCoreLlmInfo {
  provider: string | null;
  provider_type: string | null;
  model_name: string | null;
  source: "selected_llm" | "agent_config.default" | "system_config.llm" | "missing";
}

export interface RuntimeCoreProviderInfo {
  configured: boolean;
  provider_key: string | null;
  provider_name: string | null;
  provider_type: string | null;
  model_available: boolean;
  api_key_configured: boolean;
}

export interface RuntimeCoreReadiness {
  kind: "runtime_core";
  status: "configuration_missing" | "ready";
  configuration_ready: boolean;
  execution_runtime_migrated: boolean;
  can_execute: boolean;
  agent: RuntimeCoreAgentInfo;
  llm: RuntimeCoreLlmInfo;
  provider: RuntimeCoreProviderInfo;
  requirements: RuntimeCoreRequirement[];
  boundary: string;
}

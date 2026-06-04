import type { AgentConfig } from "../contracts/agent-config.js";
import type { RuntimeCoreReadiness, RuntimeCoreRequirement } from "../contracts/runtime-core.js";
import type { ModelProviderConfig, ModelMapValue } from "../contracts/model-adapter.js";

export interface RuntimeCoreReadinessInput {
  agentName?: string | null;
  teamName?: string | null;
  selectedLlm?: string | null;
}

export interface RuntimeAgentConfigPort {
  getConfig(agentName: string, options?: { teamName?: string | null }): AgentConfig | null;
  listConfigs(options?: { teamName?: string | null }): Record<string, AgentConfig>;
}

export interface RuntimeModelProviderPort {
  listProviders(): ModelProviderConfig[];
}

export interface RuntimeExecutionConfig {
  readiness: RuntimeCoreReadiness;
  agent: AgentConfig | null;
  provider: ModelProviderConfig | null;
  modelName: string | null;
}

export interface RuntimeExecutionConfigResolver {
  getReadiness(input?: RuntimeCoreReadinessInput): RuntimeCoreReadiness;
  resolveExecutionConfig(input?: RuntimeCoreReadinessInput): RuntimeExecutionConfig;
}

interface ResolvedLlm {
  provider: string | null;
  provider_type: string | null;
  model_name: string | null;
  source: "selected_llm" | "agent_config.default" | "missing";
}

export class RuntimeCoreService {
  constructor(
    private readonly agentConfigs: RuntimeAgentConfigPort,
    private readonly modelProviders: RuntimeModelProviderPort,
  ) {}

  getReadiness(input: RuntimeCoreReadinessInput = {}): RuntimeCoreReadiness {
    const agent = this.resolveAgent(input);
    const llm = this.resolveLlm(agent, input.selectedLlm);
    const provider = this.resolveProvider(llm);
    const requirements = this.buildRequirements(agent, llm, provider);
    const configurationReady = requirements
      .filter((item) => item.category !== "execution_runtime")
      .every((item) => item.satisfied);

    return {
      kind: "runtime_core",
      status: configurationReady ? "ready" : "configuration_missing",
      configuration_ready: configurationReady,
      execution_runtime_migrated: true,
      can_execute: configurationReady,
      agent: agent
        ? {
            agent_name: agent.agent_name,
            display_name: agent.display_name ?? null,
            enabled: agent.enabled,
            default_entry: agent.default_entry,
            source: "agent_config",
          }
        : {
            agent_name: null,
            display_name: null,
            enabled: false,
            default_entry: false,
            source: "missing",
          },
      llm: {
        provider: llm.provider,
        provider_type: llm.provider_type,
        model_name: llm.model_name,
        source: llm.source,
      },
      provider,
      requirements,
      boundary:
        "Minimal single-agent text execution is available in TypeScript when configuration is ready. Tool execution, multi-agent delegation, MCP runtime, vector retrieval, and advanced streaming semantics are still not migrated.",
    };
  }

  resolveExecutionConfig(input: RuntimeCoreReadinessInput = {}): RuntimeExecutionConfig {
    const agent = this.resolveAgent(input);
    const llm = this.resolveLlm(agent, input.selectedLlm);
    const provider = this.resolveProviderConfig(llm);
    return {
      readiness: this.getReadiness(input),
      agent,
      provider,
      modelName: llm.model_name,
    };
  }

  private resolveAgent(input: RuntimeCoreReadinessInput): AgentConfig | null {
    const requested = input.agentName?.trim();
    const teamName = input.teamName?.trim() || null;
    if (requested) {
      return this.agentConfigs.getConfig(requested, { teamName });
    }

    const configs = this.agentConfigs.listConfigs({ teamName });
    const defaultEntry = Object.values(configs).find((config) => config.default_entry);
    if (defaultEntry) {
      return defaultEntry;
    }
    return this.agentConfigs.getConfig("orchestrator_agent", { teamName });
  }

  private resolveLlm(agent: AgentConfig | null, selectedLlm: string | null | undefined): ResolvedLlm {
    const override = parseSelectedLlm(selectedLlm);
    if (override) {
      return {
        ...override,
        source: "selected_llm",
      };
    }

    const defaultTier = agent?.llm_tiers?.default;
    if (!defaultTier) {
      return {
        provider: null,
        provider_type: null,
        model_name: null,
        source: "missing",
      };
    }
    return {
      provider: normalizeString(defaultTier.provider),
      provider_type: normalizeString(defaultTier.provider_type),
      model_name: normalizeString(defaultTier.model_name),
      source: "agent_config.default",
    };
  }

  private resolveProvider(llm: ResolvedLlm): RuntimeCoreReadiness["provider"] {
    const provider = this.resolveProviderConfig(llm);
    if (!provider) {
      return {
        configured: false,
        provider_key: null,
        provider_name: null,
        provider_type: null,
        model_available: false,
        api_key_configured: false,
      };
    }
    return {
      configured: true,
      provider_key: provider.key ?? null,
      provider_name: provider.name,
      provider_type: provider.provider_type,
      model_available: isModelAvailable(provider, llm.model_name),
      api_key_configured: Boolean(String(provider.api_key ?? "").trim()),
    };
  }

  private resolveProviderConfig(llm: ResolvedLlm): ModelProviderConfig | null {
    return findProvider(this.modelProviders.listProviders(), llm);
  }

  private buildRequirements(
    agent: AgentConfig | null,
    llm: ResolvedLlm,
    provider: RuntimeCoreReadiness["provider"],
  ): RuntimeCoreRequirement[] {
    return [
      requirement("entry_agent", "agent", agent !== null, agent ? `入口智能体已解析: ${agent.agent_name}` : "缺少可用入口智能体", "missing_agent"),
      requirement("agent_enabled", "agent", Boolean(agent?.enabled), agent?.enabled ? "入口智能体已启用" : "入口智能体未启用或不存在", "agent_disabled"),
      requirement("system_prompt", "agent", hasSystemPrompt(agent), hasSystemPrompt(agent) ? "系统提示词已配置" : "缺少智能体系统提示词", "missing_system_prompt"),
      requirement("llm_provider_ref", "llm", Boolean(llm.provider), llm.provider ? `LLM provider 已解析: ${llm.provider}` : "缺少 LLM provider", "missing_llm_provider"),
      requirement("llm_provider_type", "llm", Boolean(llm.provider_type), llm.provider_type ? `LLM provider_type 已解析: ${llm.provider_type}` : "缺少 LLM provider_type", "missing_llm_provider_type"),
      requirement("llm_model", "llm", Boolean(llm.model_name), llm.model_name ? `LLM model 已解析: ${llm.model_name}` : "缺少 LLM model_name", "missing_llm_model"),
      requirement("model_provider_config", "provider", provider.configured, provider.configured ? `Provider 配置已找到: ${provider.provider_key}` : "缺少匹配的 Model Provider 配置", "missing_provider_config"),
      requirement("model_available", "provider", provider.model_available, provider.model_available ? "Provider 中已配置该 chat 模型" : "Provider 中缺少匹配的 chat 模型", "missing_provider_model"),
      requirement("provider_api_key", "provider", provider.api_key_configured, provider.api_key_configured ? "Provider API key 已配置" : "缺少 Provider API key", "missing_provider_api_key"),
      requirement("agent_runtime", "execution_runtime", true, "最小单 Agent 文本执行 runtime 已迁移到 TypeScript", "not_migrated"),
    ];
  }
}

function requirement(
  key: string,
  category: RuntimeCoreRequirement["category"],
  satisfied: boolean,
  message: string,
  failureCode: string,
): RuntimeCoreRequirement {
  const item: RuntimeCoreRequirement = {
    key,
    category,
    required: true,
    satisfied,
    message,
  };
  if (!satisfied) {
    item.code = failureCode;
  }
  return item;
}

function parseSelectedLlm(selectedLlm: string | null | undefined): Omit<ResolvedLlm, "source"> | null {
  const normalized = selectedLlm?.trim();
  if (!normalized) {
    return null;
  }
  const parts = normalized.split("|").map((part) => part.trim());
  if (parts.length >= 3) {
    return {
      provider: normalizeString(parts[0]),
      provider_type: normalizeString(parts[1]),
      model_name: normalizeString(parts[2]),
    };
  }
  if (parts.length === 2) {
    return {
      provider: normalizeString(parts[0]),
      provider_type: null,
      model_name: normalizeString(parts[1]),
    };
  }
  return {
    provider: normalizeString(parts[0]),
    provider_type: null,
    model_name: null,
  };
}

function findProvider(providers: ModelProviderConfig[], llm: ResolvedLlm): ModelProviderConfig | null {
  if (!llm.provider) {
    return null;
  }
  const providerRef = normalizeKey(llm.provider);
  const providerType = normalizeKey(llm.provider_type);
  return (
    providers.find((provider) => {
      if (providerType && normalizeKey(provider.provider_type) !== providerType) {
        return false;
      }
      return [provider.key, provider.name].some((value) => normalizeKey(value) === providerRef);
    }) ?? null
  );
}

function isModelAvailable(provider: ModelProviderConfig, modelName: string | null): boolean {
  if (!modelName) {
    return false;
  }
  const target = normalizeKey(modelName);
  return listChatModels(provider).some((model) => normalizeKey(model) === target);
}

function listChatModels(provider: ModelProviderConfig): string[] {
  const values: string[] = [];
  collectModelValues(provider.model_map.chat, values);
  collectModelValues(provider.model, values);
  collectModelValues(provider.models, values);
  return values;
}

function collectModelValues(value: ModelMapValue | string[] | string | undefined, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelValues(item, output);
    }
    return;
  }
  const normalized = normalizeString(value);
  if (normalized) {
    output.push(normalized);
  }
}

function hasSystemPrompt(agent: AgentConfig | null): boolean {
  const prompt = agent?.custom_params?.behavior;
  if (!isRecord(prompt)) {
    return false;
  }
  return Boolean(normalizeString(prompt.system_prompt));
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

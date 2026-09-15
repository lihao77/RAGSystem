import { isRecord, normalizeString } from "../../../utils/guards.js";
import type { AgentConfig, AgentLlmConfig } from "../../../contracts/agent/agent-config.js";
import type { RuntimeCoreReadiness, RuntimeCoreRequirement } from "../../../contracts/runtime/runtime-core.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type { SystemLlmConfig } from "../../../contracts/runtime/system-config.js";
import { findProviderByRef, isProviderModelAvailable, providerRefResolves } from "../../runtime/provider-lookup.js";
import type { SessionTeamSnapshot } from "../../../contracts/session/session.js";

export interface RuntimeCoreReadinessInput {
  agentName?: string | null;
  teamName?: string | null;
  teamSnapshot?: SessionTeamSnapshot | null;
  selectedLlm?: string | null;
}

export interface RuntimeAgentConfigPort {
  getConfig(agentName: string, options?: { teamName?: string | null }): AgentConfig | null;
  listConfigs(options?: { teamName?: string | null }): Record<string, AgentConfig>;
}

export interface RuntimeModelProviderPort {
  listProviders(): ModelProviderConfig[];
}

export interface RuntimeSystemConfigPort {
  getLlmConfig(): SystemLlmConfig;
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
  createTeamSnapshot(input?: { teamName?: string | null | undefined; entryAgentName?: string | null | undefined }): SessionTeamSnapshot;
}

interface ResolvedLlm {
  provider: string | null;
  provider_type: string | null;
  model_name: string | null;
  source: "selected_llm" | "agent_config.default" | "system_config.llm" | "missing";
  /** default 档引用解析失败（悬空/半空/缺档）而回落系统 LLM 时标注，供前端失效提示。 */
  fallback_reason: "agent_default_tier_unresolved" | null;
}

export class RuntimeCoreService {
  constructor(
    private readonly agentConfigs: RuntimeAgentConfigPort,
    private readonly modelProviders: RuntimeModelProviderPort,
    private readonly systemConfig: RuntimeSystemConfigPort | null = null,
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
        fallback_reason: llm.fallback_reason,
      },
      provider,
      requirements,
      boundary:
        "Single-agent streaming execution, tool-call loops, managed runtime tools, hooks, persisted compression, rollback/retry, provider adapters, and synchronous multi-agent delegation are available when configuration is ready. Installed plugins may contribute additional routes, tools, resources, hooks, and process runtimes.",
    };
  }

  resolveExecutionConfig(input: RuntimeCoreReadinessInput = {}): RuntimeExecutionConfig {
    const agent = this.resolveAgent(input);
    const llm = this.resolveLlm(agent, input.selectedLlm);
    const provider = this.resolveProviderConfig(llm);
    return {
      readiness: this.getReadiness(input),
      agent: this.applySystemLlmFallback(agent, llm),
      provider,
      modelName: llm.model_name,
    };
  }

  createTeamSnapshot(input: { teamName?: string | null | undefined; entryAgentName?: string | null | undefined } = {}): SessionTeamSnapshot {
    const source = this.agentConfigs as RuntimeAgentConfigPort & {
      createTeamSnapshot?: (selection?: { teamName?: string | null | undefined; entryAgentName?: string | null | undefined }) => SessionTeamSnapshot;
    };
    if (!source.createTeamSnapshot) throw new Error("Runtime Agent config does not support Team snapshots");
    return source.createTeamSnapshot(input);
  }

  private resolveAgent(input: RuntimeCoreReadinessInput): AgentConfig | null {
    const requested = input.agentName?.trim();
    if (input.teamSnapshot) {
      const agentName = requested || input.teamSnapshot.entry_agent_name;
      // 会话快照只是身份记录（属于哪个 team、入口是谁）：执行配置（含 llm_tiers
      // 引用）每次运行按快照 team 名读取当前配置，避免存量会话被过期引用永久卡死。
      // team/agent 已删除时直接判缺失（readiness 报缺少入口智能体），不回退快照
      // 副本——静默兜底会掩盖配置问题，让故障无法定位。
      return this.agentConfigs.getConfig(agentName, { teamName: input.teamSnapshot.team_name });
    }
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
      // selectedLlm 是本次运行的显式选择：解析不到直接报缺失，不静默换模型。
      return {
        ...override,
        source: "selected_llm",
        fallback_reason: null,
      };
    }

    const providers = this.modelProviders.listProviders();
    const defaultTier = agent?.llm_tiers?.default ?? null;
    if (defaultTier && providerRefResolves(providers, defaultTier)) {
      return {
        provider: normalizeString(defaultTier.provider),
        provider_type: normalizeString(defaultTier.provider_type),
        model_name: normalizeString(defaultTier.model_name),
        source: "agent_config.default",
        fallback_reason: null,
      };
    }

    // 配置失效即回落：default 档引用解析不到（悬空 provider、模型下架、半空残壳、
    // 仅有场景档）时回落系统 LLM，由 fallback_reason 标注失效供前端提示，不再硬失败。
    // 完全没有 llm_tiers 的继承是无标注的常态回落（内置 Agent 的默认形态）。
    const systemTier = this.systemLlmTier();
    if (systemTier && providerRefResolves(providers, systemTier)) {
      return {
        provider: normalizeString(systemTier.provider),
        provider_type: normalizeString(systemTier.provider_type),
        model_name: normalizeString(systemTier.model_name),
        source: "system_config.llm",
        fallback_reason: agentHasTiers(agent) ? "agent_default_tier_unresolved" : null,
      };
    }

    // 系统兜底也不可用：按 agent 配置的原始引用报缺失（比系统空引用更有排查价值）；
    // agent 完全没配 tier 时按系统 LLM 引用报。
    const reportFrom = defaultTier ?? systemTier;
    return {
      provider: normalizeString(reportFrom?.provider),
      provider_type: normalizeString(reportFrom?.provider_type),
      model_name: normalizeString(reportFrom?.model_name),
      source: "missing",
      fallback_reason: null,
    };
  }

  private applySystemLlmFallback(agent: AgentConfig | null, llm: ResolvedLlm): AgentConfig | null {
    if (!agent || llm.source !== "system_config.llm") {
      return agent;
    }
    const systemTier = this.systemLlmTier();
    return systemTier
      ? { ...agent, llm_tiers: { ...agent.llm_tiers, default: systemTier } }
      : agent;
  }

  private systemLlmTier(): AgentLlmConfig | null {
    if (!this.systemConfig) {
      return null;
    }
    return systemLlmAsTier(this.systemConfig.getLlmConfig());
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
      model_available: isProviderModelAvailable(provider, llm.model_name),
      api_key_configured: Boolean(String(provider.api_key ?? "").trim()),
    };
  }

  private resolveProviderConfig(llm: ResolvedLlm): ModelProviderConfig | null {
    return findProviderByRef(this.modelProviders.listProviders(), llm);
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
      requirement(
        "agent_runtime",
        "execution_runtime",
        true,
        "单 Agent streaming、工具循环、运行时工具、hooks、上下文压缩、rollback/retry、provider 与同步多 Agent 委派可用；已安装插件可额外贡献路由、工具、资源、hooks 与进程级运行时",
        "runtime_unavailable",
      ),
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

/** selectedLlm 字符串解析出的 LLM 引用三元组（不含 source/fallback_reason 等运行时字段）。 */
export interface SelectedLlmRef {
  provider: string | null;
  provider_type: string | null;
  model_name: string | null;
}

/**
 * 解析前端 selectedLlm 字符串（"provider|provider_type|model" / "provider|model"）。
 * 单段形态（无 model）返回 provider-only 引用，由调用方按需校验完整性。
 */
export function parseSelectedLlm(selectedLlm: string | null | undefined): SelectedLlmRef | null {
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

function agentHasTiers(agent: AgentConfig | null): boolean {
  const tiers = agent?.llm_tiers;
  return tiers !== null && tiers !== undefined && Object.keys(tiers).length > 0;
}

/**
 * 系统 LLM 配置 → AgentLlmConfig 形态（tier 同构）。runtime 兜底注入与投影层
 * 系统回落共用，保证两层注入的 default 档逐字段一致。
 */
export function systemLlmAsTier(systemLlm: SystemLlmConfig): AgentLlmConfig {
  return {
    provider: systemLlm.provider,
    provider_type: systemLlm.provider_type,
    model_name: systemLlm.model_name,
    temperature: systemLlm.temperature,
    max_completion_tokens: systemLlm.max_completion_tokens,
    max_context_tokens: systemLlm.max_context_tokens,
    extra_params: { ...systemLlm.extra_params },
  };
}

function hasSystemPrompt(agent: AgentConfig | null): boolean {
  const prompt = agent?.custom_params?.behavior;
  if (!isRecord(prompt)) {
    return false;
  }
  return Boolean(normalizeString(prompt.system_prompt));
}

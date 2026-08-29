import type { AgentConfigPort } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { ModelProviderCatalogPort } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import {
  listAgentCapabilityProviders,
} from "@ragsystem/backend-core/plugins/agent-capability-provider.js";
import { normalizeProviderKey } from "@ragsystem/backend-core/services/runtime/provider-lookup.js";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { AgentBuilderBindings } from "./service.js";

export async function createAgentBuilderBindings(input: {
  agentConfig: AgentConfigPort;
  capabilities: CapabilityRegistry;
  pluginTools?: readonly BackendToolDescriptor[];
  modelAdapter?: ModelProviderCatalogPort | null;
}): Promise<AgentBuilderBindings> {
  const providers = listAgentCapabilityProviders(input.capabilities);
  const toolNames = input.pluginTools
    ? new Set([
        ...input.agentConfig.listAvailableTools().map((tool) => tool.name),
        ...input.pluginTools.map((tool) => tool.name),
      ])
    : undefined;
  const providerItems = new Map<string, ReadonlySet<string>>();
  for (const provider of providers) {
    providerItems.set(provider.id, new Set((await provider.listItems()).map((item) => item.name)));
  }
  // 与运行时 findProviderByRef 同一匹配语义：name 与 key 均可引用同一 provider（归一化后索引）。
  const llmProviders = input.modelAdapter
    ? new Map(input.modelAdapter.listProviders().flatMap((provider) => {
        const info = { provider_type: provider.provider_type, models: provider.models.map((model) => model.name) };
        return [provider.name, provider.key]
          .map((value) => normalizeProviderKey(value))
          .filter((value, index, list) => value && list.indexOf(value) === index)
          .map((value) => [value, info] as const);
      }))
    : undefined;

  return {
    inventory: {
      ...(toolNames ? { tools: toolNames } : {}),
      ...(providerItems.size > 0 ? { providers: providerItems } : {}),
      ...(llmProviders && llmProviders.size > 0 ? { llm_providers: llmProviders } : {}),
    },
    providers,
  };
}

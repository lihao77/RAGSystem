import type { AgentConfigPort } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import {
  listAgentCapabilityProviders,
} from "@ragsystem/backend-core/plugins/agent-capability-provider.js";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { AgentBuilderBindings } from "./service.js";

export async function createAgentBuilderBindings(input: {
  agentConfig: AgentConfigPort;
  capabilities: CapabilityRegistry;
  pluginTools?: readonly BackendToolDescriptor[];
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

  return {
    inventory: {
      ...(toolNames ? { tools: toolNames } : {}),
      ...(providerItems.size > 0 ? { providers: providerItems } : {}),
    },
    providers,
  };
}

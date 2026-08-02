import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { AgentBuilderService } from "./service.js";

export interface AgentBuilderRuntimeCapability {
  readonly service: AgentBuilderService;
}

export const AGENT_BUILDER_RUNTIME_CAPABILITY = createCapability<AgentBuilderRuntimeCapability>(
  "@ragsystem/backend-plugin-agent-builder/runtime",
);

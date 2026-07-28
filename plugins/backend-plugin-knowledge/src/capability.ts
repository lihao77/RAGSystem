import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { KnowledgeApplication } from "./contracts/knowledge-application.js";
import type { KnowledgeAgentConfigService } from "./agent-config.js";

export interface KnowledgeRuntimeCapability {
  readonly application: KnowledgeApplication;
  readonly agentConfig: KnowledgeAgentConfigService;
}

export const KNOWLEDGE_RUNTIME_CAPABILITY = createCapability<KnowledgeRuntimeCapability>(
  "@ragsystem/backend-plugin-knowledge/runtime",
);

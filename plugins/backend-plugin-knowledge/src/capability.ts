import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { KnowledgeApplication } from "./contracts/knowledge-application.js";

export const KNOWLEDGE_APPLICATION_CAPABILITY = createCapability<KnowledgeApplication>(
  "@ragsystem/backend-plugin-knowledge/application",
);

import type { BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { KnowledgeApplication } from "./contracts/knowledge-application.js";
import type { KnowledgeAgentConfigService } from "./agent-config.js";

export interface KnowledgePluginLifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface KnowledgePluginRuntime {
  readonly application: KnowledgeApplication;
  readonly agentConfig: KnowledgeAgentConfigService;
  dispose?(): void;
}

export type KnowledgePluginRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => KnowledgePluginRuntime | Promise<KnowledgePluginRuntime>;

export interface KnowledgePluginDependencies {
  runtimeFactory: KnowledgePluginRuntimeFactory;
  lifecycle?: KnowledgePluginLifecycle;
}

export { KNOWLEDGE_RUNTIME_CAPABILITY, type KnowledgeRuntimeCapability } from "./capability.js";
export {
  KnowledgeAgentConfigSchema,
  KnowledgeAgentConfigService,
  type KnowledgeAgentConfig,
  type KnowledgeAgentConfigKey,
  type KnowledgeAgentConfigStore,
} from "./agent-config.js";
export type { KnowledgeApplication, KnowledgeDownload, KnowledgeUploadPart } from "./contracts/knowledge-application.js";
export * from "./contracts/knowledge/knowledge-base.js";
export * from "./contracts/knowledge/knowledge-query.js";
export * from "./contracts/vector-store/index.js";
export type {
  KnowledgePluginDependencies,
  KnowledgePluginLifecycle,
  KnowledgePluginRuntime,
  KnowledgePluginRuntimeFactory,
} from "./dependencies.js";
export { backendPluginModule } from "./module.js";
export { createKnowledgePlugin, KNOWLEDGE_PLUGIN_ID } from "./plugin.js";
export {
  KNOWLEDGE_SYSTEM_CONFIG_EXTENSION,
  createKnowledgeSystemConfigExtension,
  resolveDocumentExtractionConfig,
  type DocumentExtractionConfig,
} from "./system-config.js";
export { KnowledgeApplicationService } from "./services/knowledge/knowledge-application-service.js";
export type { KnowledgeEmbedderFactory } from "./services/knowledge/knowledge-application-service.js";
export { KnowledgeHttpApplication } from "./services/knowledge/knowledge-http-application.js";
export { DocumentExtractDispatcher } from "./services/knowledge/document-extract/dispatcher.js";
export { createLocalVectorStore } from "./storage/local/vector-store/vector-store-factory.js";
export { LocalAsyncKnowledgeMarkdownPipeline } from "./storage/local/local-async-knowledge-markdown-pipeline.js";
export { createLocalKnowledgeRuntime } from "./storage/local/runtime.js";
export { createLocalKnowledgeRuntimeFactory } from "./storage/local/runtime.js";
export type { LocalKnowledgeRuntime, LocalKnowledgeRuntimeOptions } from "./storage/local/runtime.js";
export { TenantKnowledgeMarkdownPipeline } from "./contracts/knowledge/async-knowledge-markdown-pipeline.js";
export * from "./storage/postgres/index.js";

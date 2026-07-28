import type { DocumentExtractionConfig } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import type { ModelAdapterService } from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";

import type { KnowledgeApplication } from "../../contracts/knowledge-application.js";
import { DocumentExtractDispatcher } from "../../services/knowledge/document-extract/dispatcher.js";
import {
  KnowledgeApplicationService,
  type KnowledgeEmbedderFactory,
} from "../../services/knowledge/knowledge-application-service.js";
import { KnowledgeHttpApplication } from "../../services/knowledge/knowledge-http-application.js";
import { LocalAsyncKnowledgeMarkdownPipeline } from "./local-async-knowledge-markdown-pipeline.js";
import { createLocalVectorStore } from "./vector-store/vector-store-factory.js";

export interface LocalKnowledgeRuntimeOptions {
  tenantId: string;
  dataRoot: string;
  inMemory: boolean;
  modelAdapter: ModelAdapterService;
  documentExtraction: DocumentExtractionConfig;
  embedderFactory?: KnowledgeEmbedderFactory;
}

export interface LocalKnowledgeRuntime {
  application: KnowledgeApplication;
  close(): void;
}

export function createLocalKnowledgeRuntime(options: LocalKnowledgeRuntimeOptions): LocalKnowledgeRuntime {
  const driver = createLocalVectorStore(options.dataRoot, { inMemory: options.inMemory });
  const service = new KnowledgeApplicationService(
    options.tenantId,
    options.modelAdapter,
    driver,
    driver,
    options.embedderFactory,
  );
  const markdown = new LocalAsyncKnowledgeMarkdownPipeline(
    driver,
    new DocumentExtractDispatcher(options.documentExtraction),
  );
  return {
    application: new KnowledgeHttpApplication(service, driver, markdown),
    close: () => driver.close(),
  };
}

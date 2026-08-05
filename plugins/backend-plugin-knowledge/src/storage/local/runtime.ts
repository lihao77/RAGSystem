import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { ModelProviderCatalogPort } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";

import type { KnowledgeApplication } from "../../contracts/knowledge-application.js";
import type { KnowledgePluginRuntimeFactory } from "../../dependencies.js";
import { resolveDocumentExtractionConfig, type DocumentExtractionConfig } from "../../system-config.js";
import { DocumentExtractDispatcher } from "../../services/knowledge/document-extract/dispatcher.js";
import {
  KnowledgeApplicationService,
  type KnowledgeEmbedderFactory,
} from "../../services/knowledge/knowledge-application-service.js";
import { KnowledgeHttpApplication } from "../../services/knowledge/knowledge-http-application.js";
import { LocalAsyncKnowledgeMarkdownPipeline } from "./local-async-knowledge-markdown-pipeline.js";
import { createLocalVectorStore } from "./vector-store/vector-store-factory.js";
import { KnowledgeAgentConfigService } from "../../agent-config.js";
import { SqliteKnowledgeAgentConfigStore } from "./agent-config-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface LocalKnowledgeRuntimeOptions {
  tenantId: string;
  dataRoot: string;
  inMemory: boolean;
  modelAdapter: ModelProviderCatalogPort;
  documentExtraction: DocumentExtractionConfig;
  embedderFactory?: KnowledgeEmbedderFactory;
}

export interface LocalKnowledgeRuntime {
  application: KnowledgeApplication;
  agentConfig: KnowledgeAgentConfigService;
  close(): void;
}

export interface LocalKnowledgeRuntimeFactoryOptions {
  embedderFactory?: KnowledgeEmbedderFactory;
}

export function createLocalKnowledgeRuntimeFactory(
  options: LocalKnowledgeRuntimeFactoryOptions = {},
): KnowledgePluginRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "local") {
      throw new Error("Local Knowledge runtime factory requires a Local deployment");
    }
    const runtime = createLocalKnowledgeRuntime({
      tenantId: context.tenantId,
      dataRoot: context.dataRoot,
      inMemory: false,
      modelAdapter: context.modelAdapter,
      documentExtraction: resolveDocumentExtractionConfig(
        context.systemConfig.getSection("document_extraction"),
      ),
      ...(options.embedderFactory ? { embedderFactory: options.embedderFactory } : {}),
    });
    return {
      application: runtime.application,
      agentConfig: runtime.agentConfig,
      dispose: () => runtime.close(),
    };
  };
}

export function createLocalKnowledgeRuntime(options: LocalKnowledgeRuntimeOptions): LocalKnowledgeRuntime {
  const driver = createLocalVectorStore(options.dataRoot, { inMemory: options.inMemory });
  const dbPath = options.inMemory ? ":memory:" : path.join(options.dataRoot, "db", "knowledge.db");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const configDb = new DatabaseSync(dbPath);
  configDb.exec("PRAGMA busy_timeout = 5000");
  const agentConfig = new KnowledgeAgentConfigService(
    new SqliteKnowledgeAgentConfigStore(configDb, options.tenantId),
  );
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
    agentConfig,
    close: () => {
      configDb.close();
      driver.close();
    },
  };
}

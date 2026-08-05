import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import type { ModelAdapterService } from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";

import type { KnowledgeApplication } from "../../contracts/knowledge-application.js";
import { TenantKnowledgeMarkdownPipeline } from "../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { KnowledgePluginRuntimeFactory } from "../../dependencies.js";
import { DocumentExtractDispatcher } from "../../services/knowledge/document-extract/dispatcher.js";
import { KnowledgeApplicationService } from "../../services/knowledge/knowledge-application-service.js";
import { KnowledgeHttpApplication } from "../../services/knowledge/knowledge-http-application.js";
import type { KnowledgePostgresExecutor } from "./executor.js";
import { PostgresKnowledgeConfigRepository } from "./knowledge-config-repository.js";
import { PostgresKnowledgeFileMetadataRepository } from "./knowledge-file-repository.js";
import { SaaSKnowledgeFileStorage } from "./knowledge-file-storage.js";
import { PostgresPgVectorRepository } from "./pgvector-repository.js";
import { KnowledgeAgentConfigService } from "../../agent-config.js";
import { PostgresKnowledgeAgentConfigStore } from "./agent-config-store.js";
import { resolveDocumentExtractionConfig, type DocumentExtractionConfig } from "../../system-config.js";

export interface PostgresKnowledgeRuntimeOptions {
  tenantId: string;
  executor: KnowledgePostgresExecutor;
  objects: ObjectStorage;
  modelAdapter: ModelAdapterService;
  documentExtraction: DocumentExtractionConfig;
}

export interface PostgresKnowledgeRuntimeFactoryOptions {
  executor: KnowledgePostgresExecutor;
  objects: ObjectStorage;
}

export function createPostgresKnowledgeRuntimeFactory(
  options: PostgresKnowledgeRuntimeFactoryOptions,
): KnowledgePluginRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("Postgres Knowledge runtime factory requires a SaaS deployment");
    }
    return {
      application: createPostgresKnowledgeApplication({
        tenantId: context.tenantId,
        executor: options.executor,
        objects: options.objects,
        modelAdapter: context.modelAdapter,
        documentExtraction: resolveDocumentExtractionConfig(
          context.systemConfig.getSection("document_extraction"),
        ),
      }),
      agentConfig: new KnowledgeAgentConfigService(
        new PostgresKnowledgeAgentConfigStore(options.executor, context.tenantId),
      ),
    };
  };
}

export function createPostgresKnowledgeApplication(
  options: PostgresKnowledgeRuntimeOptions,
): KnowledgeApplication {
  const service = new KnowledgeApplicationService(
    options.tenantId,
    options.modelAdapter,
    new PostgresKnowledgeConfigRepository(options.executor),
    new PostgresPgVectorRepository(options.executor),
  );
  const files = new SaaSKnowledgeFileStorage(
    options.tenantId,
    new PostgresKnowledgeFileMetadataRepository(options.executor),
    options.objects,
  );
  const dispatcher = new DocumentExtractDispatcher(options.documentExtraction);
  const markdown = new TenantKnowledgeMarkdownPipeline(files, async ({ body, fileName, mime }) => {
    const temporaryPath = path.join(os.tmpdir(), `ragsystem-knowledge-${randomUUID()}-${path.basename(fileName)}`);
    await fs.writeFile(temporaryPath, body);
    try {
      return (await dispatcher.extract({ file_path: temporaryPath, file_name: fileName, mime })).markdown;
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  });
  return new KnowledgeHttpApplication(service, files, markdown);
}

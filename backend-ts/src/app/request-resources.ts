import type { FastifyRequest } from "fastify";
import type { AsyncKnowledgeFileStore } from "../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { AsyncSessionFileStorage } from "../contracts/session-file-storage.js";
import type { AsyncFileHistoryStore } from "../contracts/file-history-store/index.js";
import type { RouteOptions } from "../routes/route-options.js";

export interface RequestResources {
  knowledgeFileStore?: AsyncKnowledgeFileStore;
  knowledgeMarkdownPipeline?: AsyncKnowledgeMarkdownPipeline;
  sessionFileStorage?: AsyncSessionFileStorage;
  fileHistoryStorage?: AsyncFileHistoryStore;
}

export async function ensureRequestResources(request: FastifyRequest, options: RouteOptions): Promise<RequestResources> {
  if (!request.resources) request.resources = await createRequestResources(request, options);
  return request.resources;
}

export async function createRequestResources(request: FastifyRequest, options: RouteOptions): Promise<RequestResources> {
  const [knowledgeFileStore, sessionFileStorage, fileHistoryStorage] = await Promise.all([
    options.resolveKnowledgeFileStore?.(request),
    options.resolveSessionFileStorage?.(request),
    options.resolveFileHistoryStorage?.(request),
  ]);
  const knowledgeMarkdownPipeline = await options.resolveKnowledgeMarkdownPipeline?.(request);
  return {
    ...(knowledgeFileStore ? { knowledgeFileStore } : {}),
    ...(knowledgeMarkdownPipeline ? { knowledgeMarkdownPipeline } : {}),
    ...(sessionFileStorage ? { sessionFileStorage } : {}),
    ...(fileHistoryStorage ? { fileHistoryStorage } : {}),
  };
}

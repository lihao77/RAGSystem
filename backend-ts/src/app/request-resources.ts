import type { FastifyRequest } from "fastify";
import type { AsyncKnowledgeFileStore } from "../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { AsyncSessionFileStorage } from "../contracts/session/session-file-storage.js";
import type { AsyncFileHistoryStore } from "../contracts/file-history-store/index.js";
import type { RouteOptions } from "../routes/route-options.js";
import { requireDeploymentResolution } from "./deployment-resolution.js";

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
  const [resolvedKnowledgeFileStore, resolvedSessionFileStorage, resolvedFileHistoryStorage] = await Promise.all([
    options.resolveKnowledgeFileStore?.(request),
    options.resolveSessionFileStorage?.(request),
    options.resolveFileHistoryStorage?.(request),
  ]);
  const resolvedKnowledgeMarkdownPipeline = await options.resolveKnowledgeMarkdownPipeline?.(request);
  const knowledgeFileStore = requireDeploymentResolution(request, "knowledge file store", resolvedKnowledgeFileStore);
  const sessionFileStorage = requireDeploymentResolution(request, "session file storage", resolvedSessionFileStorage);
  const fileHistoryStorage = requireDeploymentResolution(request, "file history storage", resolvedFileHistoryStorage);
  const knowledgeMarkdownPipeline = requireDeploymentResolution(
    request,
    "knowledge markdown pipeline",
    resolvedKnowledgeMarkdownPipeline,
  );
  return {
    ...(knowledgeFileStore ? { knowledgeFileStore } : {}),
    ...(knowledgeMarkdownPipeline ? { knowledgeMarkdownPipeline } : {}),
    ...(sessionFileStorage ? { sessionFileStorage } : {}),
    ...(fileHistoryStorage ? { fileHistoryStorage } : {}),
  };
}

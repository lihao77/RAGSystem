import type { FastifyRequest } from "fastify";
import type { AsyncKnowledgeFileStore } from "../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { AsyncSessionFileStorage } from "../contracts/session/session-file-storage.js";
import type { AsyncFileHistoryStore } from "../contracts/file-history-store/index.js";
import type { RouteOptions } from "../routes/route-options.js";

/** Legacy request cache retained for compatibility; business routes use application ports. */
export interface RequestResources {
  knowledgeFileStore: AsyncKnowledgeFileStore;
  knowledgeMarkdownPipeline: AsyncKnowledgeMarkdownPipeline;
  sessionFileStorage: AsyncSessionFileStorage;
  fileHistoryStorage: AsyncFileHistoryStore;
}

export async function ensureRequestResources(request: FastifyRequest, options: RouteOptions): Promise<RequestResources> {
  if (!request.resources) request.resources = await createRequestResources(request, options);
  return request.resources;
}

export async function createRequestResources(request: FastifyRequest, options: RouteOptions): Promise<RequestResources> {
  const [knowledgeFileStore, knowledgeMarkdownPipeline, sessionFileStorage, fileHistoryStorage] = await Promise.all([
    resolve("knowledge file store", options.resolveKnowledgeFileStore, request),
    resolve("knowledge markdown pipeline", options.resolveKnowledgeMarkdownPipeline, request),
    resolve("session file storage", options.resolveSessionFileStorage, request),
    resolve("file history storage", options.resolveFileHistoryStorage, request),
  ]);
  return { knowledgeFileStore, knowledgeMarkdownPipeline, sessionFileStorage, fileHistoryStorage };
}

async function resolve<T>(name: string, resolver: ((request: FastifyRequest) => T | undefined | Promise<T | undefined>) | undefined, request: FastifyRequest): Promise<T> {
  if (!resolver) throw new Error(`SaaS ${name} resolver returned no implementation`);
  const value = await resolver(request);
  if (!value) throw new Error(`SaaS ${name} resolver returned no implementation`);
  return value;
}

import { asRecord } from "../../utils/guards.js";
import { z } from "zod";

import type { VectorSearchResult } from "../../contracts/knowledge-base.js";
import type { KnowledgeQueryPort } from "../../contracts/knowledge/query-port.js";
import {
  LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
  SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { RuntimeToolDefinition } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../../services/agent/sdk/tool-results.js";
import type { AgentConfig } from "../../contracts/agent-config.js";
import { metadataFrom, optionalBoolean, optionalInteger, optionalRecord, optionalString } from "../schema-helpers.js";

export interface KnowledgeToolDeps {
  knowledge: KnowledgeQueryPort | null;
  agent: AgentConfig;
}

const searchKnowledgeBaseSchema = z.object({
  query: z.string(),
  collection: optionalString,
  collection_name: optionalString,
  top_k: optionalInteger,
  topK: optionalInteger,
  search_mode: z.enum(["vector", "hybrid"]).optional().nullable(),
  searchMode: optionalString,
  rerank: optionalBoolean,
  filters: optionalRecord,
}).strict();

const emptyArgsSchema = z.object({}).strict();

const KNOWLEDGE_TOOLS: RuntimeToolDefinition[] = [
  {
    name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
    source: "knowledge",
    category: "knowledge",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Search the enabled Agent knowledge base for document chunks relevant to a query. Uses Agent knowledge_base defaults when optional fields are omitted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query text.",
        },
        collection: {
          type: "string",
          description: "Knowledge collection name. Defaults to the Agent knowledge_base default_collection.",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          description: "Maximum result count. Defaults to the Agent knowledge_base default_top_k.",
        },
        search_mode: {
          type: "string",
          enum: ["vector", "hybrid"],
          description: "Search mode. Defaults to the Agent knowledge_base default_search_mode.",
        },
        rerank: {
          type: "boolean",
          description: "Whether to rerank hybrid results. Defaults to the Agent knowledge_base default_rerank.",
        },
        filters: {
          type: "object",
          description: "Optional metadata filters reserved for vector-store compatible callers.",
        },
      },
    },
  },
  {
    name: LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
    source: "knowledge",
    category: "knowledge",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List available knowledge base collections and their document/chunk counts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

export function createKnowledgeTools(deps: KnowledgeToolDeps): Tool[] {
  const knowledge = deps.knowledge;
  if (!knowledge) {
    return [];
  }
  const agent = deps.agent;
  // 可见性筛选：agent.knowledge_base.enabled === true 时返回两个工具，否则返回 []
  if (agent.knowledge_base.enabled !== true) {
    return [];
  }
  const kbConfig = agent.knowledge_base;
  const definitionByName = new Map(KNOWLEDGE_TOOLS.map((definition) => [definition.name, definition]));
  return [
    buildTool({
      ...metadataFrom(definitionByName.get(SEARCH_KNOWLEDGE_BASE_TOOL_NAME)!),
      inputSchema: searchKnowledgeBaseSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input, _ctx: ToolExecContext) => {
        const collection = input.collection ?? input.collection_name ?? kbConfig.default_collection ?? "documents";
        const searchMode = normalizeSearchMode(input.search_mode ?? input.searchMode ?? kbConfig.default_search_mode);
        const topK = input.top_k ?? input.topK ?? kbConfig.default_top_k ?? 5;
        const rerank = input.rerank ?? kbConfig.default_rerank ?? false;
        try {
          const search = await knowledge.search({
            query: input.query,
            collection,
            top_k: topK,
            search_mode: searchMode,
            rerank,
            filters: input.filters ?? undefined,
            reranker_key: kbConfig.default_reranker_key ?? undefined,
          });
          const results = Array.isArray(search.results) ? search.results as VectorSearchResult[] : [];
          return toolSuccess(
            formatSearchResults(results),
            {
              toolName: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
              summary: `在 ${collection} 中搜索到 ${results.length} 条结果`,
              outputType: "text",
              metadata: {
                count: results.length,
                collection,
                search_mode: searchMode,
              },
            },
          );
        } catch (error) {
          return toolError(
            SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
            `知识库搜索失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME)!),
      inputSchema: emptyArgsSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (_input, _ctx: ToolExecContext) => {
        try {
          const collections = await knowledge.listCollections();
          const content = collections.length
            ? collections.map((collection) => {
                const name = String(collection.name ?? "");
                const docCount = Number(collection.document_count ?? asRecord(collection.metadata)?.document_count ?? 0);
                const chunkCount = Number(collection.chunk_count ?? collection.total_chunks ?? 0);
                return `- ${name}: ${docCount} 文档, ${chunkCount} 分块`;
              }).join("\n")
            : "当前没有可用的知识库集合。";
          return toolSuccess(
            content,
            {
              toolName: LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
              summary: collections.length ? `共 ${collections.length} 个集合` : "无可用集合",
              outputType: "text",
              metadata: { count: collections.length },
            },
          );
        } catch (error) {
          return toolError(
            LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
            `列出集合失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  ];
}

function normalizeSearchMode(value: string | null | undefined): "hybrid" | "vector" {
  return value?.trim().toLowerCase() === "vector" ? "vector" : "hybrid";
}

function formatSearchResults(results: VectorSearchResult[]): string {
  if (!results.length) {
    return "未找到相关结果。";
  }
  return results.map((item, index) => {
    const source = String(item.metadata.source_file ?? item.metadata.source ?? "").trim();
    const score = item.similarity || item.hybrid_score || item.rerank_score || 0;
    const header = `[${index + 1}]${source ? ` ${source}` : ""}${score ? ` (score: ${score.toFixed(4)})` : ""}`;
    return `${header}\n${item.content.trim()}`;
  }).join("\n\n");
}


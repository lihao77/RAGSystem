import type { VectorLibraryService, VectorSearchResult } from "../../knowledge/vector-library-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
  ToolExecutionResult,
} from "../runtime-tool-types.js";
import { errorResult, readSearchKnowledgeBaseArguments } from "../runtime-tool-bridge/arguments.js";
import {
  KNOWLEDGE_TOOLS,
  LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
  SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
} from "../runtime-tool-bridge/registry.js";

export class KnowledgeToolProvider implements RuntimeToolProvider {
  readonly id = "knowledge";

  constructor(private readonly vectorLibrary: VectorLibraryService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    return this.vectorLibrary && input.agent?.knowledge_base.enabled
      ? KNOWLEDGE_TOOLS.map((tool) => ({ ...tool }))
      : [];
  }

  canHandle(toolName: string): boolean {
    return toolName === SEARCH_KNOWLEDGE_BASE_TOOL_NAME || toolName === LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME;
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    const toolName = call.toolName.trim();
    if (!this.vectorLibrary) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    if (toolName === SEARCH_KNOWLEDGE_BASE_TOOL_NAME) {
      return this.searchKnowledgeBase(call, context);
    }
    if (toolName === LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME) {
      return this.listCollections();
    }
    return errorResult(`Knowledge provider cannot handle tool: ${toolName}`, toolName || "unknown");
  }

  private searchKnowledgeBase(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult<string> {
    const vectorLibrary = this.vectorLibrary!;
    const input = readSearchKnowledgeBaseArguments(call.arguments);
    const kbConfig = context.agent?.knowledge_base;
    const collection = input.collection ?? kbConfig?.default_collection ?? "documents";
    const searchMode = normalizeSearchMode(input.searchMode ?? kbConfig?.default_search_mode);
    const topK = input.topK ?? kbConfig?.default_top_k ?? 5;
    const rerank = input.rerank ?? kbConfig?.default_rerank ?? false;
    try {
      const search = vectorLibrary.search({
        query: input.query,
        collection,
        top_k: topK,
        search_mode: searchMode,
        rerank,
        filters: input.filters ?? undefined,
        reranker_key: kbConfig?.default_reranker_key ?? undefined,
      });
      const results = Array.isArray(search.results) ? search.results as VectorSearchResult[] : [];
      return {
        success: true,
        tool_name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
        summary: `在 ${collection} 中搜索到 ${results.length} 条结果`,
        answer: null,
        output_type: "text",
        content: formatSearchResults(results),
        metadata: {
          count: results.length,
          collection,
          search_mode: searchMode,
        },
        artifacts: [],
        llm_hint: null,
      };
    } catch (error) {
      return errorResult(
        `知识库搜索失败: ${error instanceof Error ? error.message : String(error)}`,
        SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
      );
    }
  }

  private listCollections(): ToolExecutionResult<string> {
    const vectorLibrary = this.vectorLibrary!;
    try {
      const collections = vectorLibrary.listCollections();
      const content = collections.length
        ? collections.map((collection) => {
            const name = String(collection.name ?? "");
            const docCount = Number(collection.document_count ?? asRecord(collection.metadata)?.document_count ?? 0);
            const chunkCount = Number(collection.chunk_count ?? collection.total_chunks ?? 0);
            return `- ${name}: ${docCount} 文档, ${chunkCount} 分块`;
          }).join("\n")
        : "当前没有可用的知识库集合。";
      return {
        success: true,
        tool_name: LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
        summary: collections.length ? `共 ${collections.length} 个集合` : "无可用集合",
        answer: null,
        output_type: "text",
        content,
        metadata: { count: collections.length },
        artifacts: [],
        llm_hint: null,
      };
    } catch (error) {
      return errorResult(
        `列出集合失败: ${error instanceof Error ? error.message : String(error)}`,
        LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
      );
    }
  }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

import type {
  KnowledgeCollectionSummary,
  KnowledgeQueryPort,
  KnowledgeSearchResponse,
} from "../../../contracts/knowledge/query-port.js";
import type { SearchVectorsRequest } from "../../../contracts/knowledge/knowledge-base.js";

/** Tenant-bound Agent knowledge queries backed by PostgreSQL/pgvector. */
export class PostgresKnowledgeQueryAdapter implements KnowledgeQueryPort {
  private readonly knowledge: KnowledgeQueryPort;

  constructor(knowledge: KnowledgeQueryPort | string, baseKnowledge?: { withAsyncVectorStore: (vectors: unknown, tenantId: string) => KnowledgeQueryPort }, vectors?: unknown) {
    this.knowledge = typeof knowledge === "string"
      ? baseKnowledge!.withAsyncVectorStore(vectors, knowledge)
      : knowledge;
  }

  async search(input: SearchVectorsRequest): Promise<KnowledgeSearchResponse> {
    return await this.knowledge.search(input) as unknown as KnowledgeSearchResponse;
  }

  async listCollections(): Promise<KnowledgeCollectionSummary[]> {
    return await this.knowledge.listCollections() as unknown as KnowledgeCollectionSummary[];
  }
}

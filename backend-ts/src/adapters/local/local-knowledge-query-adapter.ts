import type {
  KnowledgeCollectionSummary,
  KnowledgeQueryPort,
  KnowledgeSearchResponse,
} from "../../contracts/knowledge/query-port.js";
import type { SearchVectorsRequest } from "../../contracts/knowledge-base.js";
import type { KnowledgeBaseService } from "../../services/knowledge/knowledge-base-service.js";

/** Local knowledge query adapter backed by the configured vector driver. */
export class LocalKnowledgeQueryAdapter implements KnowledgeQueryPort {
  constructor(private readonly knowledge: Pick<KnowledgeBaseService, "search" | "listCollections">) {}

  async search(input: SearchVectorsRequest): Promise<KnowledgeSearchResponse> {
    return await this.knowledge.search(input) as unknown as KnowledgeSearchResponse;
  }

  async listCollections(): Promise<KnowledgeCollectionSummary[]> {
    return await this.knowledge.listCollections() as unknown as KnowledgeCollectionSummary[];
  }
}

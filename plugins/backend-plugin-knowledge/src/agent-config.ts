import { z } from "zod";

export const KnowledgeAgentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  default_collection: z.string().trim().min(1).default("documents"),
  default_search_mode: z.enum(["vector", "hybrid"]).default("hybrid"),
  default_top_k: z.number().int().min(1).max(50).default(5),
  default_rerank: z.boolean().default(false),
  default_reranker_key: z.string().trim().min(1).nullable().default(null),
}).strict();

export type KnowledgeAgentConfig = z.infer<typeof KnowledgeAgentConfigSchema>;

export interface KnowledgeAgentConfigKey {
  teamName: string;
  agentName: string;
}

export interface KnowledgeAgentConfigStore {
  get(key: KnowledgeAgentConfigKey): Promise<unknown | null>;
  put(key: KnowledgeAgentConfigKey, config: KnowledgeAgentConfig): Promise<void>;
  delete(key: KnowledgeAgentConfigKey): Promise<boolean>;
}

export class KnowledgeAgentConfigService {
  constructor(private readonly store: KnowledgeAgentConfigStore) {}

  defaults(): KnowledgeAgentConfig {
    return KnowledgeAgentConfigSchema.parse({});
  }

  async getEffective(key: KnowledgeAgentConfigKey): Promise<KnowledgeAgentConfig> {
    const stored = await this.store.get(normalizeKey(key));
    return stored == null ? this.defaults() : KnowledgeAgentConfigSchema.parse(stored);
  }

  async put(key: KnowledgeAgentConfigKey, input: unknown): Promise<KnowledgeAgentConfig> {
    const config = KnowledgeAgentConfigSchema.parse(input);
    await this.store.put(normalizeKey(key), config);
    return config;
  }

  async delete(key: KnowledgeAgentConfigKey): Promise<KnowledgeAgentConfig> {
    await this.store.delete(normalizeKey(key));
    return this.defaults();
  }
}

function normalizeKey(key: KnowledgeAgentConfigKey): KnowledgeAgentConfigKey {
  const teamName = key.teamName.trim();
  const agentName = key.agentName.trim();
  if (!teamName || !agentName) throw new Error("teamName and agentName are required");
  return { teamName, agentName };
}

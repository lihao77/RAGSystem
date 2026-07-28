import { z } from "zod";

export const McpAgentConfigSchema = z.object({
  enabled_servers: z.array(z.string().trim().min(1)).default([]),
}).strict();

export type McpAgentConfig = z.infer<typeof McpAgentConfigSchema>;

export interface McpAgentConfigKey {
  teamName: string;
  agentName: string;
}

export interface McpAgentConfigStore {
  get(key: McpAgentConfigKey): Promise<unknown | null>;
  put(key: McpAgentConfigKey, config: McpAgentConfig): Promise<void>;
  delete(key: McpAgentConfigKey): Promise<boolean>;
}

export class McpAgentConfigService {
  constructor(private readonly store: McpAgentConfigStore) {}

  defaults(): McpAgentConfig {
    return McpAgentConfigSchema.parse({});
  }

  async getEffective(key: McpAgentConfigKey): Promise<McpAgentConfig> {
    const stored = await this.store.get(normalizeKey(key));
    return stored == null ? this.defaults() : McpAgentConfigSchema.parse(stored);
  }

  async put(key: McpAgentConfigKey, input: unknown): Promise<McpAgentConfig> {
    const config = McpAgentConfigSchema.parse(input);
    await this.store.put(normalizeKey(key), config);
    return config;
  }

  async delete(key: McpAgentConfigKey): Promise<McpAgentConfig> {
    await this.store.delete(normalizeKey(key));
    return this.defaults();
  }
}

function normalizeKey(key: McpAgentConfigKey): McpAgentConfigKey {
  const teamName = key.teamName.trim();
  const agentName = key.agentName.trim();
  if (!teamName || !agentName) throw new Error("teamName and agentName are required");
  return { teamName, agentName };
}

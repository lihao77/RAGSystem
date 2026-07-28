import { z } from "zod";

export const SkillsAgentConfigSchema = z.object({
  enabled_skills: z.array(z.string()).default([]),
}).strict();

export type SkillsAgentConfig = z.infer<typeof SkillsAgentConfigSchema>;

export interface SkillsAgentConfigKey {
  teamName: string;
  agentName: string;
}

export interface SkillsAgentConfigStore {
  get(key: SkillsAgentConfigKey): Promise<unknown | null>;
  put(key: SkillsAgentConfigKey, config: SkillsAgentConfig): Promise<void>;
  delete(key: SkillsAgentConfigKey): Promise<boolean>;
  purgeSkillReference(skillName: string): Promise<string[]>;
}

export class SkillsAgentConfigService {
  constructor(private readonly store: SkillsAgentConfigStore) {}

  defaults(): SkillsAgentConfig {
    return SkillsAgentConfigSchema.parse({});
  }

  async getEffective(key: SkillsAgentConfigKey): Promise<SkillsAgentConfig> {
    const stored = await this.store.get(normalizeKey(key));
    return stored == null ? this.defaults() : SkillsAgentConfigSchema.parse(stored);
  }

  async put(key: SkillsAgentConfigKey, input: unknown): Promise<SkillsAgentConfig> {
    const config = SkillsAgentConfigSchema.parse(input);
    await this.store.put(normalizeKey(key), config);
    return config;
  }

  async delete(key: SkillsAgentConfigKey): Promise<SkillsAgentConfig> {
    await this.store.delete(normalizeKey(key));
    return this.defaults();
  }

  purgeSkillReference(skillName: string): Promise<string[]> {
    return this.store.purgeSkillReference(skillName.trim());
  }
}

function normalizeKey(key: SkillsAgentConfigKey): SkillsAgentConfigKey {
  const teamName = key.teamName.trim();
  const agentName = key.agentName.trim();
  if (!teamName || !agentName) throw new Error("teamName and agentName are required");
  return { teamName, agentName };
}

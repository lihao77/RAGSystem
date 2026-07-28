import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/services/config/system-config-service.js";

const MemoryScopeNameSchema = z.enum(["team", "session", "agent", "workspace", "user"]);

export const MemoryAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  auto_inject: z.boolean().default(true),
  allowed_scopes: z.array(MemoryScopeNameSchema).default(["team", "session", "user"]),
  write_scopes: z.array(MemoryScopeNameSchema).default(["session", "user"]),
  archive_scopes: z.array(MemoryScopeNameSchema).default(["session", "user"]),
}).strict();

export type MemoryAgentConfig = z.infer<typeof MemoryAgentConfigSchema>;

export interface MemoryAgentConfigKey {
  teamName: string;
  agentName: string;
}

export interface MemoryAgentConfigStore {
  get(key: MemoryAgentConfigKey): Promise<unknown | null>;
  put(key: MemoryAgentConfigKey, config: MemoryAgentConfig): Promise<void>;
  delete(key: MemoryAgentConfigKey): Promise<boolean>;
}

export class MemoryAgentConfigService {
  constructor(private readonly store: MemoryAgentConfigStore) {}

  defaults(): MemoryAgentConfig {
    return MemoryAgentConfigSchema.parse({});
  }

  async getEffective(key: MemoryAgentConfigKey): Promise<MemoryAgentConfig> {
    const stored = await this.store.get(normalizeKey(key));
    return stored == null ? this.defaults() : MemoryAgentConfigSchema.parse(stored);
  }

  async put(key: MemoryAgentConfigKey, input: unknown): Promise<MemoryAgentConfig> {
    const config = MemoryAgentConfigSchema.parse(input);
    await this.store.put(normalizeKey(key), config);
    return config;
  }

  async delete(key: MemoryAgentConfigKey): Promise<MemoryAgentConfig> {
    await this.store.delete(normalizeKey(key));
    return this.defaults();
  }
}

function normalizeKey(key: MemoryAgentConfigKey): MemoryAgentConfigKey {
  const teamName = key.teamName.trim();
  const agentName = key.agentName.trim();
  if (!teamName || !agentName) throw new Error("teamName and agentName are required");
  return { teamName, agentName };
}

export const MEMORY_SCOPE_METADATA = [
  { name: "team", description: "团队级长期记忆，适合跨会话复用的共享偏好、约束与背景事实。" },
  { name: "session", description: "当前会话记忆，适合记录本轮协作中形成的稳定偏好和上下文。" },
  { name: "agent", description: "当前 team 内 Agent 私有记忆。" },
  { name: "workspace", description: "当前工作区记忆，由运行时工作区身份定位。" },
  { name: "user", description: "当前用户的长期记忆，适合跨团队和工作区复用。" },
] as const;

export const MEMORY_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    memory: {
      index_max_lines: 200,
      index_max_chars: 25_600,
    },
  },
  groups: [
    {
      key: "memory",
      label: "记忆系统",
      description: "记忆系统配置",
      fields: [
        {
          key: "index_max_lines",
          label: "Index Max Lines",
          type: "number",
          default: 200,
          help: "记忆索引注入最大行数",
          min: 10,
          step: 1,
        },
        {
          key: "index_max_chars",
          label: "Index Max Chars",
          type: "number",
          default: 25_600,
          help: "记忆索引注入最大字符数",
          min: 1_024,
          step: 1,
        },
      ],
    },
  ],
};

export interface MemorySystemConfig {
  index_max_lines: number;
  index_max_chars: number;
}

export function resolveMemorySystemConfig(value: unknown): MemorySystemConfig {
  const parsed = z.object({
    index_max_lines: z.number().int().positive().optional().default(200),
    index_max_chars: z.number().int().positive().optional().default(25_600),
  }).safeParse(value);
  return parsed.success ? parsed.data : { index_max_lines: 200, index_max_chars: 25_600 };
}

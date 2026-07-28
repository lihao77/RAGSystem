import { z } from "zod";

import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { SystemConfigExtension } from "@ragsystem/backend-core/services/config/system-config-service.js";

const MemoryScopeNameSchema = z.enum(["team", "session", "agent", "workspace", "user"]);

export const MemoryAgentConfigSchema = z.object({
  auto_inject: z.boolean().optional().default(true),
  allowed_scopes: z.array(MemoryScopeNameSchema).optional().default(["team", "session", "user"]),
  write_scopes: z.array(MemoryScopeNameSchema).optional().default(["session", "user"]),
  archive_scopes: z.array(MemoryScopeNameSchema).optional().default(["session", "user"]),
});

export type MemoryAgentConfig = z.infer<typeof MemoryAgentConfigSchema>;

export function resolveMemoryAgentConfig(agent: AgentConfig | null): MemoryAgentConfig {
  const parsed = MemoryAgentConfigSchema.safeParse(agent?.memory);
  return parsed.success ? parsed.data : MemoryAgentConfigSchema.parse(undefined);
}

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

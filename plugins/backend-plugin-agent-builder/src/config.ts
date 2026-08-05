import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/services/config/system-config-service.js";

const AgentBuilderApprovalSchema = z.object({
  auto_publish_candidates: z.boolean().optional().default(false),
}).strict();

export type AgentBuilderApprovalConfig = z.infer<typeof AgentBuilderApprovalSchema>;

export const AGENT_BUILDER_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    agent_builder: {
      approval: {
        auto_publish_candidates: false,
      },
    },
  },
  groups: [
    {
      key: "agent_builder.approval",
      label: "Agent Builder 审批",
      description: "控制 Agent Draft 是否在校验通过后自动发布到 Team。",
      fields: [
        {
          key: "auto_publish_candidates",
          label: "自动发布 Agent Draft",
          type: "boolean",
          default: false,
          help: "校验通过后自动创建或更新同名 Team，但不会自动激活。",
        },
      ],
    },
  ],
};

export function createAgentBuilderSystemConfigExtension(
  currentValue: unknown,
): SystemConfigExtension {
  const approval = resolveAgentBuilderApprovalConfig(currentValue);
  return {
    ...AGENT_BUILDER_SYSTEM_CONFIG_EXTENSION,
    defaults: {
      agent_builder: {
        approval,
      },
    },
  };
}

export function resolveAgentBuilderApprovalConfig(value: unknown): AgentBuilderApprovalConfig {
  const current = readApproval(value);
  const parsed = AgentBuilderApprovalSchema.safeParse(current);
  return parsed.success ? parsed.data : { auto_publish_candidates: false };
}

function readApproval(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.approval ?? value;
}

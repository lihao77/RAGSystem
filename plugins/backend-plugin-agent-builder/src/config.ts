import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/services/config/system-config-service.js";

const AgentBuilderApprovalSchema = z.object({
  auto_publish_releases: z.boolean().optional().default(false),
}).strict();

export type AgentBuilderApprovalConfig = z.infer<typeof AgentBuilderApprovalSchema>;

export const AGENT_BUILDER_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    agent_builder: {
      approval: {
        auto_publish_releases: false,
      },
    },
  },
  groups: [
    {
      key: "agent_builder.approval",
      label: "Agent Builder 审批",
      description: "控制 Agent Draft 是否在校验通过后自动发布为 Release。",
      fields: [
        {
          key: "auto_publish_releases",
          label: "自动发布 Agent Release",
          type: "boolean",
          default: false,
          help: "自动发布新版本，但不会自动激活线上 Team。",
        },
      ],
    },
  ],
};

export function createAgentBuilderSystemConfigExtension(
  currentValue: unknown,
  legacyValue?: unknown,
): SystemConfigExtension {
  const approval = resolveAgentBuilderApprovalConfig(currentValue, legacyValue);
  return {
    ...AGENT_BUILDER_SYSTEM_CONFIG_EXTENSION,
    defaults: {
      agent_builder: {
        approval,
      },
    },
  };
}

export function resolveAgentBuilderApprovalConfig(value: unknown, legacyValue?: unknown): AgentBuilderApprovalConfig {
  const current = readApproval(value);
  const parsed = AgentBuilderApprovalSchema.safeParse(current);
  if (parsed.success) return parsed.data;

  const legacy = legacyValue && typeof legacyValue === "object" ? legacyValue as Record<string, unknown> : {};
  return {
    auto_publish_releases: legacy.auto_approve_agent_releases === true,
  };
}

function readApproval(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.approval ?? value;
}

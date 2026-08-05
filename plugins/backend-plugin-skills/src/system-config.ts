import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/services/config/system-config-service.js";

const SkillsApprovalSchema = z.object({
  auto_publish_candidates: z.boolean().optional().default(false),
}).strict();

export type SkillsApprovalConfig = z.infer<typeof SkillsApprovalSchema>;

export const SKILLS_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    skills: {
      approval: {
        auto_publish_candidates: false,
      },
    },
  },
  groups: [
    {
      key: "skills.approval",
      label: "Skills 审批",
      description: "控制 Skill Draft 是否在校验通过后自动发布。",
      fields: [
        {
          key: "auto_publish_candidates",
          label: "自动发布 Skill",
          type: "boolean",
          default: false,
          help: "自动发布完整且通过校验的 Skill Draft。",
        },
      ],
    },
  ],
};

export function createSkillsSystemConfigExtension(
  currentValue: unknown,
  legacyValue?: unknown,
): SystemConfigExtension {
  const approval = resolveSkillsApprovalConfig(currentValue, legacyValue);
  return {
    ...SKILLS_SYSTEM_CONFIG_EXTENSION,
    defaults: {
      skills: {
        approval,
      },
    },
  };
}

export function resolveSkillsApprovalConfig(value: unknown, legacyValue?: unknown): SkillsApprovalConfig {
  const current = readApproval(value);
  const parsed = SkillsApprovalSchema.safeParse(current);
  if (parsed.success) return parsed.data;

  const legacy = legacyValue && typeof legacyValue === "object" ? legacyValue as Record<string, unknown> : {};
  return {
    auto_publish_candidates: legacy.auto_approve_skill_drafts === true,
  };
}

function readApproval(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.approval ?? value;
}

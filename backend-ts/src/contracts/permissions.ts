import { z } from "zod";

export const PermissionModeSchema = z.enum([
  "strict",
  "standard",
  "relaxed",
  "dangerously_skip_permissions",
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

export const AutoAcceptPatternSchema = z.object({
  pattern_type: z.string().min(1),
  pattern_value: z.string().min(1),
  description: z.string().optional().default(""),
});

export const ToolPermissionSchema = z.object({
  tool_name: z.string().min(1),
  risk_level: RiskLevelSchema.optional().default("low"),
  description: z.string().optional().default(""),
  allowed_roles: z.array(z.string()).optional().default([]),
  allowed_callers: z.array(z.string()).optional().default(["direct", "code_execution"]),
  timeout_seconds: z.number().int().positive().optional().default(60),
});

export const PermissionPolicySchema = z.object({
  mode: PermissionModeSchema.optional().default("standard"),
  auto_accept_patterns: z.array(AutoAcceptPatternSchema).optional().default([]),
  audit_all_checks: z.boolean().optional().default(false),
  approval_timeout: z.number().int().positive().optional().default(300),
  skip_all_approvals: z.boolean().optional().default(false),
});

export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type AutoAcceptPattern = z.infer<typeof AutoAcceptPatternSchema>;
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

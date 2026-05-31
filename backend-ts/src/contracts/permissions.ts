import { z } from "zod";

export const PermissionModeSchema = z.enum([
  "strict",
  "standard",
  "relaxed",
  "dangerously_skip_permissions",
]);

export const AutoAcceptPatternSchema = z.object({
  pattern_type: z.string().min(1),
  pattern_value: z.string().min(1),
  description: z.string().optional().default(""),
});

export const PermissionPolicySchema = z.object({
  mode: PermissionModeSchema.optional().default("standard"),
  auto_accept_patterns: z.array(AutoAcceptPatternSchema).optional().default([]),
  audit_all_checks: z.boolean().optional().default(false),
  approval_timeout: z.number().int().positive().optional().default(300),
  skip_all_approvals: z.boolean().optional().default(false),
});

export const SetModeRequestSchema = z.object({
  mode: PermissionModeSchema,
});

export const PatternRequestSchema = z.object({
  pattern_type: z.string().min(1),
  pattern_value: z.string().min(1),
  description: z.string().optional().default(""),
});

export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type AutoAcceptPattern = z.infer<typeof AutoAcceptPatternSchema>;
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;
export type SetModeRequest = z.infer<typeof SetModeRequestSchema>;
export type PatternRequest = z.infer<typeof PatternRequestSchema>;

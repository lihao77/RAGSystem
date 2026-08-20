import { z } from "zod";

const TenantIdSchema = z.string().regex(/^tnt_[a-z0-9]+(?:_[a-z0-9]+)*$/);
const UserIdSchema = z.string().regex(/^usr_[a-z0-9]+(?:_[a-z0-9]+)*$/);

export const TenantRoleSchema = z.enum(["owner", "admin", "member"]);
export const PlatformRoleSchema = z.literal("admin");

/**
 * 安装请求：部署形态由运行中的后端决定（local/saas 是不同的部署包），
 * 此处不再携带形态选择。SaaS 安装须提供管理员账号；local 形态免安装。
 */
export const InstallRequestSchema = z.object({
  admin: z.object({
    username: z.string().trim().min(1),
    password: z.string().min(8),
  }).strict().optional(),
  tenantDisplayName: z.string().trim().min(1).optional(),
}).strict();

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
}).strict();

export const SwitchTenantRequestSchema = z.object({
  tenantId: TenantIdSchema,
}).strict();

export const AuthUserSchema = z.object({
  id: UserIdSchema,
  displayName: z.string(),
}).strict();

export const AuthSessionSchema = z.object({
  token: z.string().min(1),
  expires_at: z.number().int().positive(),
  user: AuthUserSchema,
  tenantId: TenantIdSchema,
  role: TenantRoleSchema,
  platformRole: PlatformRoleSchema.optional(),
}).strict();

export const AuthIdentitySchema = z.object({
  user: AuthUserSchema,
  userId: UserIdSchema,
  tenantId: TenantIdSchema,
  role: TenantRoleSchema,
  permissions: z.array(z.string()),
  platformRole: PlatformRoleSchema.optional(),
}).strict();

export const LogoutResponseSchema = z.object({
  success: z.literal(true),
}).strict();

export type InstallRequest = z.infer<typeof InstallRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SwitchTenantRequest = z.infer<typeof SwitchTenantRequestSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type AuthIdentity = z.infer<typeof AuthIdentitySchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

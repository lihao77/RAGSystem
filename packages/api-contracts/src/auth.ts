import { z } from "zod";

const TenantIdSchema = z.string().regex(/^tnt_[a-z0-9]+(?:_[a-z0-9]+)*$/);
const UserIdSchema = z.string().regex(/^usr_[a-z0-9]+(?:_[a-z0-9]+)*$/);

export const TenantRoleSchema = z.enum(["owner", "admin", "member"]);
export const PlatformRoleSchema = z.literal("admin");

export const AuthUserSchema = z.object({
  id: UserIdSchema,
  displayName: z.string(),
}).strict();

export const AuthIdentitySchema = z.object({
  user: AuthUserSchema,
  userId: UserIdSchema,
  tenantId: TenantIdSchema,
  role: TenantRoleSchema,
  permissions: z.array(z.string()),
  platformRole: PlatformRoleSchema.optional(),
}).strict();

export type AuthIdentity = z.infer<typeof AuthIdentitySchema>;

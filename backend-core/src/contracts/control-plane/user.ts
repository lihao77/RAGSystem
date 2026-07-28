import { z } from "zod";
import { createTenantId, createUserId } from "../../identity/types.js";

const UserIdSchema = z.string().transform(createUserId);
const TenantIdSchema = z.string().transform(createTenantId);

export const UserTypeSchema = z.enum(["human", "bot"]);
export const UserStatusSchema = z.enum(["active", "disabled"]);
export const PlatformRoleSchema = z.literal("admin");
export const TenantRoleSchema = z.enum(["owner", "admin", "member"]);

export const UserSchema = z.object({
  id: UserIdSchema,
  displayName: z.string(),
  createdAt: z.string(),
  username: z.string().optional(),
  platformRole: PlatformRoleSchema.optional(),
  status: UserStatusSchema,
  type: UserTypeSchema,
  owner_id: UserIdSchema.nullable(),
});

export const BotSchema = UserSchema.extend({
  type: z.literal("bot"),
  owner_id: UserIdSchema,
});

export const MembershipSchema = z.object({
  userId: UserIdSchema,
  tenantId: TenantIdSchema,
  role: TenantRoleSchema,
  type: UserTypeSchema,
});

export type User = z.infer<typeof UserSchema>;
export type Bot = z.infer<typeof BotSchema>;
export type UserType = z.infer<typeof UserTypeSchema>;
export type Membership = z.infer<typeof MembershipSchema>;

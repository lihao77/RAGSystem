import { z } from "zod";

const TenantIdSchema = z.string().regex(/^tnt_[a-z0-9]+(?:_[a-z0-9]+)*$/);

/** 本地"场景"：底层即租户（独立数据目录与运行库），本地模式不呈现成员语义。 */
export const LocalSceneSchema = z.object({
  id: TenantIdSchema,
  displayName: z.string().min(1),
  createdAt: z.string(),
  status: z.enum(["active", "suspended"]),
}).strict();

export const ListLocalScenesResponseSchema = z.object({
  success: z.literal(true),
  scenes: z.array(LocalSceneSchema),
  activeTenantId: TenantIdSchema,
}).strict();

export const CreateLocalSceneRequestSchema = z.object({
  displayName: z.string().trim().min(1),
}).strict();

export const RenameLocalSceneRequestSchema = z.object({
  displayName: z.string().trim().min(1),
}).strict();

export const CreateLocalSceneResponseSchema = z.object({
  success: z.literal(true),
  scene: LocalSceneSchema,
}).strict();

export const RenameLocalSceneResponseSchema = z.object({
  success: z.literal(true),
  scene: LocalSceneSchema,
}).strict();

export const ActivateLocalSceneResponseSchema = z.object({
  success: z.literal(true),
  tenantId: TenantIdSchema,
}).strict();

export const DeleteLocalSceneResponseSchema = z.object({
  success: z.literal(true),
}).strict();

export type LocalScene = z.infer<typeof LocalSceneSchema>;
export type ListLocalScenesResponse = z.infer<typeof ListLocalScenesResponseSchema>;
export type CreateLocalSceneRequest = z.infer<typeof CreateLocalSceneRequestSchema>;
export type CreateLocalSceneResponse = z.infer<typeof CreateLocalSceneResponseSchema>;
export type RenameLocalSceneRequest = z.infer<typeof RenameLocalSceneRequestSchema>;
export type RenameLocalSceneResponse = z.infer<typeof RenameLocalSceneResponseSchema>;
export type ActivateLocalSceneResponse = z.infer<typeof ActivateLocalSceneResponseSchema>;
export type DeleteLocalSceneResponse = z.infer<typeof DeleteLocalSceneResponseSchema>;

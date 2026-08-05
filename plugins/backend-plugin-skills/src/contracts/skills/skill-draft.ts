import { z } from "zod";

const SkillNameSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must use lower-case letters, digits, or hyphens");

export const SkillDraftContentSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(1_000),
  content: z.string().trim().min(1).max(30_000),
}).strict();

export const SkillDraftAssetSchema = z.object({
  relative_path: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(200),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  body_base64: z.string().min(1),
}).strict();

export const SkillDraftAssetViewSchema = SkillDraftAssetSchema.omit({ body_base64: true });

export const SkillDraftSchema = SkillDraftContentSchema.extend({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "published"]),
  source_session_id: z.string().min(1).nullable(),
  source_agent_name: z.string().min(1).nullable(),
  published_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  skill_metadata: z.record(z.unknown()).default({}),
  bundle_assets: z.array(SkillDraftAssetSchema).default([]),
}).strict();

export const PublishSkillDraftSchema = z.object({
  expected_revision: z.number().int().positive(),
}).strict();

export const CreateSkillDraftSchema = SkillDraftContentSchema.pick({
  name: true,
  description: true,
}).strict();

export const UpdateSkillDraftSchema = SkillDraftContentSchema.extend({
  expected_revision: z.number().int().positive(),
}).strict();

export const PutSkillDraftFileSchema = z.object({
  expected_revision: z.number().int().positive(),
  relative_path: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(200).optional(),
  body_base64: z.string().min(1).max(70 * 1024 * 1024),
}).strict();

export const DeleteSkillDraftFileQuerySchema = z.object({
  path: z.string().trim().min(1).max(512),
  expected_revision: z.coerce.number().int().positive(),
}).strict();

export type SkillDraftContent = z.infer<typeof SkillDraftContentSchema>;
export type CreateSkillDraft = z.infer<typeof CreateSkillDraftSchema>;
export type UpdateSkillDraft = z.infer<typeof UpdateSkillDraftSchema>;
export type PutSkillDraftFile = z.infer<typeof PutSkillDraftFileSchema>;
export type SkillDraft = z.infer<typeof SkillDraftSchema>;
export type SkillDraftPackageState = "not_published" | "available" | "missing" | "conflict" | "unknown";
export type SkillDraftAssetView = z.infer<typeof SkillDraftAssetViewSchema>;
export type SkillDraftView = Omit<SkillDraft, "bundle_assets"> & {
  bundle_assets: SkillDraftAssetView[];
  package_state: SkillDraftPackageState;
};

export function toSkillDraftView(
  draft: SkillDraft,
  packageState: SkillDraftPackageState,
): SkillDraftView {
  return {
    ...draft,
    bundle_assets: draft.bundle_assets.map(({ body_base64: _bodyBase64, ...asset }) => asset),
    package_state: packageState,
  };
}

/** Storage-level conflict used to preserve a stable HTTP 409 contract. */
export class SkillDraftNameConflictError extends Error {
  constructor() {
    super("A draft with this Skill name already exists");
    this.name = "SkillDraftNameConflictError";
  }
}

export function isSkillDraftNameConflict(error: unknown): boolean {
  if (error instanceof SkillDraftNameConflictError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const constraint = typeof candidate.constraint === "string" ? candidate.constraint : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return constraint.includes("skill_drafts_tenant_name")
    || message.includes("skill_drafts_tenant_name")
    || message.includes("UNIQUE constraint failed: skill_drafts.tenant_id, skill_drafts.name");
}

export interface SkillDraftStore {
  list(): Promise<SkillDraft[]>;
  get(id: string): Promise<SkillDraft | null>;
  create(draft: SkillDraft): Promise<void>;
  update(expectedRevision: number, draft: SkillDraft): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

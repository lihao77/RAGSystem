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

export const SkillDraftSchema = SkillDraftContentSchema.extend({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "published"]),
  source_session_id: z.string().min(1).nullable(),
  source_agent_name: z.string().min(1).nullable(),
  published_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export const UpdateSkillDraftSchema = SkillDraftContentSchema.extend({
  expected_revision: z.number().int().positive(),
}).strict();

export const PublishSkillDraftSchema = z.object({
  expected_revision: z.number().int().positive(),
}).strict();

export const DeleteSkillDraftSchema = PublishSkillDraftSchema;

export type SkillDraftContent = z.infer<typeof SkillDraftContentSchema>;
export type SkillDraft = z.infer<typeof SkillDraftSchema>;
export type SkillDraftPackageState = "not_published" | "available" | "missing" | "conflict" | "unknown";
export type SkillDraftView = SkillDraft & { package_state: SkillDraftPackageState };

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
  delete(id: string, expectedRevision: number): Promise<boolean>;
}

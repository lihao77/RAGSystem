import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { parseSkillMarkdown } from "./skill-markdown.js";
import type { CreateSkillPackageBundleInput, SkillPackageBundleFile } from "./skill-package-store.js";

export const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const SkillContentSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(1_000),
  content: z.string().trim().min(1).max(30_000),
}).strict();
export const SkillBundleFileSchema = z.object({
  relative_path: z.string().min(1).max(512),
  media_type: z.string().min(1).max(200).optional(),
  body_base64: z.string().max(70 * 1024 * 1024),
}).strict();
export const SaveSkillBundleSchema = z.object({
  expected_revision: z.string().regex(/^[a-f0-9]{24,64}$/).nullable(),
  files: z.array(SkillBundleFileSchema).min(1).max(256),
}).strict();
export type SkillBundleFile = z.infer<typeof SkillBundleFileSchema>;
export type SaveSkillBundle = z.infer<typeof SaveSkillBundleSchema>;

export function requireSkillPath(value: string): string {
  // Portable bundle names: reject traversal, Windows aliases/ADS and symlinks at the reader.
  if (value.length > 512 || value.includes("\\") || value.split("/").some((part) =>
    !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new HttpError(422, "validation_failed", `Invalid Skill file path: ${value}`);
  }
  return value;
}

export function decodeSkillFiles(files: readonly SkillBundleFile[]): SkillPackageBundleFile[] {
  return files.map((file) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.body_base64)) {
      throw new HttpError(422, "validation_failed", `Invalid base64: ${file.relative_path}`);
    }
    return { relativePath: file.relative_path, body: Buffer.from(file.body_base64, "base64"), ...(file.media_type ? { mediaType: file.media_type } : {}) };
  });
}

export function validateSkillBundle(name: string, files: readonly SkillPackageBundleFile[]): CreateSkillPackageBundleInput {
  SkillNameSchema.parse(name);
  if (!files.length || files.length > 256) throw new HttpError(422, "validation_failed", "Skill must contain 1–256 files");
  const seen = new Set<string>();
  const reserved = new Set([".venv", "node_modules", "__pycache__", ".cache", ".installed", ".ds_store", ".materialized"]);
  let bytes = 0;
  for (const file of files) {
    const key = requireSkillPath(file.relativePath).toLowerCase();
    if (key === "manifest.json" || key.split("/").some((part) => reserved.has(part))) throw new HttpError(422, "validation_failed", `Reserved Skill file path: ${file.relativePath}`);
    if (seen.has(key)) throw new HttpError(422, "validation_failed", `Duplicate Skill file: ${file.relativePath}`);
    seen.add(key);
    bytes += file.body.byteLength;
    if (bytes > 50 * 1024 * 1024) throw new HttpError(413, "payload_too_large", "Skill bundle cannot exceed 50MB");
  }
  for (const key of seen) {
    const parts = key.split("/");
    while (parts.pop() && parts.length) {
      if (seen.has(parts.join("/"))) throw new HttpError(422, "validation_failed", "Skill file conflicts with a directory");
    }
  }
  const markdown = files.find((file) => file.relativePath === "SKILL.md");
  const parsed = markdown && parseSkillMarkdown(Buffer.from(markdown.body).toString("utf8"));
  if (!parsed) throw new HttpError(422, "validation_failed", "Skill requires a valid root SKILL.md");
  const content = SkillContentSchema.parse({ name: parsed.name, description: parsed.description, content: parsed.content });
  if (content.name !== name) throw new HttpError(422, "validation_failed", "SKILL.md name must match the Skill name");
  return { ...content, files, metadata: parsed.metadata };
}

export function skillBundleRevision(name: string, files: readonly SkillPackageBundleFile[]): string {
  const hash = createHash("sha256").update(name).update("\0");
  for (const file of [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)) {
    hash.update(JSON.stringify([file.relativePath, file.body.byteLength])).update(file.body);
  }
  return hash.digest("hex");
}

export function skillRevisionConflict(): HttpError {
  return new HttpError(409, "conflict", "Skill 已被其他操作修改，请重新加载后合并修改");
}

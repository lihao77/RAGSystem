import { createHash, randomUUID } from "node:crypto";

import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

import {
  isSkillDraftNameConflict,
  SkillDraftContentSchema,
  SkillDraftSchema,
  SkillDraftAssetSchema,
  toSkillDraftView,
  type SkillDraft,
  type SkillDraftView,
  type SkillDraftStore,
} from "../contracts/skills/skill-draft.js";
import type { SkillLibraryService } from "./skill-library-service.js";
import { parseSkillMarkdown, updateSkillMarkdownFrontmatter } from "../contracts/skills/skill-markdown.js";
import type { SkillArtifactApplication } from "../resources.js";

export interface SubmitSkillArtifactOptions {
  name?: string | null;
  description?: string | null;
  sourceAgentName?: string | null;
  sourceSessionId?: string | null;
}

/** Owns copied Skill Artifact candidates and promotes approved bundles through SkillLibraryService. */
export class SkillAuthoringService {
  constructor(
    private readonly store: SkillDraftStore,
    private readonly library: SkillLibraryService,
    private readonly artifacts: SkillArtifactApplication | null = null,
  ) {}

  listDrafts(): Promise<SkillDraft[]> {
    return this.store.list();
  }

  async getDraft(id: string): Promise<SkillDraft> {
    const draft = await this.store.get(id);
    if (!draft) throw new HttpError(404, "not_found", `Skill draft '${id}' does not exist`);
    return draft;
  }

  async listDraftViews(): Promise<SkillDraftView[]> {
    return this.attachPackageStates(await this.listDrafts());
  }

  async getDraftView(id: string): Promise<SkillDraftView> {
    const [view] = await this.attachPackageStates([await this.getDraft(id)]);
    return view!;
  }

  async submitArtifact(
    artifactId: string,
    expectedRevision: number,
    options: SubmitSkillArtifactOptions = {},
  ): Promise<SkillDraft> {
    if (!this.artifacts) throw new HttpError(503, "dependency_unavailable", "Artifact 插件未启用，无法提交 Skill Artifact");
    if (!options.sourceSessionId?.trim()) {
      throw new HttpError(400, "invalid_request", "必须从当前 Session 提交 Skill Artifact");
    }
    const normalizedArtifactId = artifactId.trim();
    if (!normalizedArtifactId || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new HttpError(400, "invalid_request", "artifact_id 与 expected_revision 必填且有效");
    }
    const existing = (await this.store.list()).find(
      (draft) => draft.source_artifact_id === normalizedArtifactId && draft.source_artifact_revision === expectedRevision,
    );
    if (existing) {
      if (existing.source_session_id !== options.sourceSessionId.trim()) {
        throw new HttpError(403, "forbidden", "只能从当前 Session 提交 Skill Artifact");
      }
      return existing;
    }
    const manifest = await this.artifacts.getArtifact(normalizedArtifactId);
    if (manifest.revision !== expectedRevision) {
      throw new HttpError(409, "conflict", `Artifact revision conflict: expected ${expectedRevision}, current ${manifest.revision}`);
    }
    if (manifest.session_id !== options.sourceSessionId.trim()) {
      throw new HttpError(403, "forbidden", "只能从当前 Session 提交 Skill Artifact");
    }
    if (manifest.status !== "ready") throw new HttpError(409, "conflict", "只有 ready 状态的 Artifact 才能提交为 Skill");
    if (manifest.kind !== "skill") throw new HttpError(400, "invalid_request", "Artifact kind 必须是 skill");
    if (manifest.assets.length === 0 || manifest.assets.length > 256) {
      throw new HttpError(400, "invalid_request", "Skill Artifact 必须包含 1-256 个文件");
    }
    const bundleAssets = [];
    const seenPaths = new Set<string>();
    const bundlePaths = isRecord(manifest.metadata) && isRecord(manifest.metadata.skill_bundle_paths)
      ? manifest.metadata.skill_bundle_paths
      : {};
    let totalBytes = 0;
    for (const asset of manifest.assets) {
      const mappedPath = bundlePaths[asset.asset_id];
      const declaredPath = typeof mappedPath === "string"
        ? mappedPath
        : asset.filename;
      const relativePath = normalizeBundlePath(declaredPath);
      if (!relativePath) throw new HttpError(400, "invalid_request", `Artifact 文件路径非法: ${declaredPath}`);
      const pathKey = relativePath.toLowerCase();
      if (seenPaths.has(pathKey)) throw new HttpError(400, "invalid_request", `Artifact 文件路径重复: ${relativePath}`);
      seenPaths.add(pathKey);
      const content = await this.artifacts.getArtifactAsset(manifest.artifact_id, asset.asset_id);
      const body = Buffer.from(content.body);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (body.byteLength !== asset.size || sha256 !== asset.sha256 || content.sha256 !== asset.sha256) {
        throw new HttpError(409, "conflict", `Artifact 文件校验失败: ${relativePath}`);
      }
      totalBytes += body.byteLength;
      if (totalBytes > 50 * 1024 * 1024) throw new HttpError(413, "payload_too_large", "Skill Artifact 总大小不能超过 50MB");
      bundleAssets.push(SkillDraftAssetSchema.parse({
        relative_path: relativePath,
        media_type: asset.media_type,
        size: body.byteLength,
        sha256,
        body_base64: body.toString("base64"),
      }));
    }
    const skillMd = bundleAssets.find((asset) => asset.relative_path.toLowerCase() === "skill.md");
    if (!skillMd || skillMd.relative_path !== "SKILL.md") {
      throw new HttpError(400, "invalid_request", "Skill Artifact 必须在根目录包含 SKILL.md");
    }
    const parsed = parseSkillMarkdown(Buffer.from(skillMd.body_base64, "base64").toString("utf8"));
    if (!parsed) throw new HttpError(400, "invalid_request", "SKILL.md frontmatter 无效");
    const content = SkillDraftContentSchema.parse({
      name: options.name?.trim() || parsed.name || slugify(manifest.title),
      description: options.description?.trim() || parsed.description || manifest.title,
      content: parsed.content,
    });
    const now = new Date().toISOString();
    const draft = SkillDraftSchema.parse({
      ...content,
      id: `skill_candidate_${randomUUID().replaceAll("-", "")}`,
      revision: 1,
      status: "draft",
      source_session_id: manifest.session_id,
      source_agent_name: options.sourceAgentName?.trim() || null,
      source_artifact_id: manifest.artifact_id,
      source_artifact_revision: manifest.revision,
      source_run_id: typeof manifest.provenance.run_id === "string"
        ? manifest.provenance.run_id
        : typeof manifest.provenance.runId === "string" ? manifest.provenance.runId : null,
      skill_metadata: parsed.metadata,
      bundle_assets: bundleAssets,
      published_at: null,
      created_at: now,
      updated_at: now,
    });
    try {
      await this.store.create(draft);
    } catch (error) {
      const duplicateArtifact = (await this.store.list()).find(
        (candidate) => candidate.source_artifact_id === manifest.artifact_id
          && candidate.source_artifact_revision === manifest.revision,
      );
      if (duplicateArtifact) return duplicateArtifact;
      if (isSkillDraftNameConflict(error)) {
        throw new HttpError(409, "conflict", `A Skill candidate already targets '${content.name}'`);
      }
      throw error;
    }
    return draft;
  }

  async deleteDraft(id: string, expectedRevision: number): Promise<{ id: string }> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    if (current.status === "published") {
      throw new HttpError(409, "conflict", "Published Skill draft history cannot be deleted");
    }
    if (!await this.store.delete(id, current.revision)) {
      const latest = await this.getDraft(id);
      throw revisionConflict(expectedRevision, latest);
    }
    return { id };
  }

  async publishDraft(id: string, expectedRevision: number): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    const packageState = await this.inspectPackage(current);
    if (current.status === "published") {
      if (packageState === "matching") return current;
      if (packageState === "conflict") {
        throw new HttpError(409, "conflict", `Skill '${current.name}' exists but does not match this published draft`);
      }
      return this.materializePublishedDraft(current, true);
    }
    if (packageState !== "absent") {
      throw new HttpError(409, "conflict", `Skill '${current.name}' already exists; publishing will not overwrite it`);
    }

    const publishedAt = new Date().toISOString();
    const published = SkillDraftSchema.parse({
      ...current,
      revision: current.revision + 1,
      status: "published",
      published_at: publishedAt,
      updated_at: publishedAt,
    });

    // Promote the draft first. This makes it impossible for a package to
    // enter the available Skill inventory while its draft is still pending.
    if (!await this.store.update(current.revision, published)) {
      throw revisionConflict(expectedRevision, await this.getDraft(id));
    }

    return this.materializePublishedDraft(published, false);
  }

  private async materializePublishedDraft(current: SkillDraft, acquireRepairRevision: boolean): Promise<SkillDraft> {
    let promoted = current;
    if (acquireRepairRevision) {
      promoted = SkillDraftSchema.parse({
        ...current,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      });
      if (!await this.store.update(current.revision, promoted)) {
        throw revisionConflict(current.revision, await this.getDraft(current.id));
      }
    }

    try {
      if (promoted.bundle_assets.length === 0) {
        throw new HttpError(409, "conflict", "该候选没有完整 Skill Artifact bundle，不能发布");
      }
      const files = materializeBundleFiles(promoted);
      await this.library.createSkillBundle({
        name: promoted.name,
        description: promoted.description,
        content: promoted.content,
        files,
        metadata: {
          ...promoted.skill_metadata,
          source_artifact_id: promoted.source_artifact_id,
          source_artifact_revision: promoted.source_artifact_revision,
          source_run_id: promoted.source_run_id,
        },
      });
      return promoted;
    } catch (error) {
      let packageState: PackageState;
      try {
        packageState = await this.inspectPackage(promoted);
      } catch (verificationError) {
        throw new AggregateError(
          [error, verificationError],
          "Skill publish failed after draft promotion and package state could not be verified; retry the publish action",
        );
      }
      if (packageState === "matching") return promoted;
      try {
        await this.rollbackPromotion(promoted);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Skill publish failed and rollback was incomplete");
      }
      throw error;
    }
  }

  private async rollbackPromotion(promoted: SkillDraft): Promise<void> {
    const latest = await this.store.get(promoted.id);
    // Another publisher acquired a newer revision and now owns recovery.
    if (!latest || latest.status !== "published" || latest.revision !== promoted.revision) return;
    const reverted = SkillDraftSchema.parse({
      ...latest,
      revision: latest.revision + 1,
      status: "draft",
      published_at: null,
      updated_at: new Date().toISOString(),
    });
    if (!await this.store.update(latest.revision, reverted)) {
      const after = await this.store.get(promoted.id);
      if (after?.status === "published" && after.revision === promoted.revision) {
        throw new Error(`Skill draft '${promoted.id}' could not be rolled back`);
      }
    }
  }

  private async inspectPackage(draft: SkillDraft): Promise<PackageState> {
    const listed = (await this.library.listSkills()).find((skill) => skill.name === draft.name);
    if (!listed) return "absent";
    if (listed.source_type !== "user_global") return "conflict";
    const detail = await this.library.getSkillDetail(draft.name);
    if (detail.source_type !== "user_global"
      || detail.description !== draft.description
      || detail.content !== draft.content) return "conflict";
    const files = materializeBundleFiles(draft).map(({ relativePath, body }) => ({ relativePath, body }));
    return await this.library.matchesSkillBundle(draft.name, files) ? "matching" : "conflict";
  }

  /** Remove a published package while keeping its copied candidate editable. */
  async restoreCandidateAfterReleaseDelete(name: string): Promise<SkillDraft | null> {
    const candidate = (await this.store.list()).find((draft) => draft.name === name && draft.status === "published");
    if (!candidate) return null;
    const restored = SkillDraftSchema.parse({
      ...candidate,
      revision: candidate.revision + 1,
      status: "draft",
      published_at: null,
      updated_at: new Date().toISOString(),
    });
    if (!await this.store.update(candidate.revision, restored)) {
      throw revisionConflict(candidate.revision, await this.getDraft(candidate.id));
    }
    return restored;
  }

  private async attachPackageStates(drafts: SkillDraft[]): Promise<SkillDraftView[]> {
    if (!drafts.some((draft) => draft.status === "published")) {
      return drafts.map((draft) => toSkillDraftView(draft, "not_published"));
    }
    let sources: Map<string, string>;
    try {
      sources = new Map((await this.library.listSkills()).map((skill) => [skill.name, skill.source_type]));
    } catch {
      return drafts.map((draft) => toSkillDraftView(
        draft,
        draft.status === "published" ? "unknown" : "not_published",
      ));
    }
    return drafts.map((draft) => {
      if (draft.status !== "published") return toSkillDraftView(draft, "not_published");
      const source = sources.get(draft.name);
      const packageState = source === undefined ? "missing" : source === "user_global" ? "available" : "conflict";
      return toSkillDraftView(draft, packageState);
    });
  }
}

function materializeBundleFiles(draft: SkillDraft): Array<{
  relativePath: string;
  mediaType: string;
  body: Buffer;
}> {
  const files = draft.bundle_assets.map((asset) => {
    const body = Buffer.from(asset.body_base64, "base64");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (body.byteLength !== asset.size || sha256 !== asset.sha256 || !normalizeBundlePath(asset.relative_path)) {
      throw new HttpError(409, "conflict", `Skill candidate 文件校验失败: ${asset.relative_path}`);
    }
    return { relativePath: asset.relative_path, mediaType: asset.media_type, body };
  });
  const skillMdIndex = files.findIndex((file) => file.relativePath === "SKILL.md");
  if (skillMdIndex < 0) throw new HttpError(409, "conflict", "Skill candidate bundle 缺少 SKILL.md");
  const originalSkillMd = files[skillMdIndex]!;
  const parsedOriginal = parseSkillMarkdown(originalSkillMd.body.toString("utf8"));
  if (!parsedOriginal) throw new HttpError(409, "conflict", "Skill candidate 的 SKILL.md 无法解析");
  if (parsedOriginal.name !== draft.name || parsedOriginal.description !== draft.description) {
    files[skillMdIndex] = {
      relativePath: "SKILL.md",
      mediaType: originalSkillMd.mediaType || "text/markdown; charset=utf-8",
      body: Buffer.from(
        updateSkillMarkdownFrontmatter(originalSkillMd.body.toString("utf8"), draft.name, draft.description),
        "utf8",
      ),
    };
  }
  return files;
}

function normalizeBundlePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0") || normalized.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return normalized;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || "skill";
}

type PackageState = "absent" | "matching" | "conflict";

function assertRevision(draft: SkillDraft, expectedRevision: number): void {
  if (draft.revision !== expectedRevision) throw revisionConflict(expectedRevision, draft);
}

function revisionConflict(expectedRevision: number, draft: SkillDraft): HttpError {
  return new HttpError(
    409,
    "conflict",
    `Skill draft revision conflict: expected ${expectedRevision}, current ${draft.revision}`,
  );
}

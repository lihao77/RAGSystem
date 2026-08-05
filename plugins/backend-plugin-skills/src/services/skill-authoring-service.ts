import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import type { SystemConfigService } from "@ragsystem/backend-core/services/config/system-config-service.js";

import {
  isSkillDraftNameConflict,
  SkillDraftContentSchema,
  SkillDraftSchema,
  SkillDraftAssetSchema,
  toSkillDraftView,
  type SkillDraft,
  type SkillDraftContent,
  type SkillDraftView,
  type SkillDraftStore,
} from "../contracts/skills/skill-draft.js";
import type { SkillLibraryService } from "./skill-library-service.js";
import { parseSkillMarkdown, serializeSkillMd, updateSkillMarkdown, updateSkillMarkdownFrontmatter } from "../contracts/skills/skill-markdown.js";
import { resolveSkillsApprovalConfig } from "../system-config.js";

/** Owns Skill Draft workspaces and promotes validated bundles through SkillLibraryService. */
export class SkillAuthoringService {
  constructor(
    private readonly store: SkillDraftStore,
    private readonly library: SkillLibraryService,
    private readonly systemConfig: SystemConfigService | null = null,
  ) {}

  listDrafts(): Promise<SkillDraft[]> {
    return this.store.list();
  }

  async searchDrafts(query: string | null | undefined): Promise<SkillDraft[]> {
    const normalized = (query ?? "").trim().toLowerCase();
    if (!normalized) return this.listDrafts();
    return (await this.listDrafts()).filter((draft) => [draft.id, draft.name, draft.description].join(" ").toLowerCase().includes(normalized));
  }

  async getDraft(id: string): Promise<SkillDraft> {
    const draft = await this.store.get(id);
    if (!draft) throw new HttpError(404, "not_found", `Skill draft '${id}' does not exist`);
    return draft;
  }

  async createDraft(name: string, description: string): Promise<SkillDraft> {
    const content = "Add the reusable instructions for this Skill before publishing.";
    const now = new Date().toISOString();
    const body = Buffer.from(serializeSkillMd(name, description, content), "utf8");
    const draft = SkillDraftSchema.parse({
      id: `skill_draft_${randomUUID().replaceAll("-", "")}`,
      name,
      description,
      content,
      revision: 1,
      status: "draft",
      source_session_id: null,
      source_agent_name: null,
      skill_metadata: {},
      bundle_assets: [SkillDraftAssetSchema.parse({
        relative_path: "SKILL.md",
        media_type: "text/markdown; charset=utf-8",
        size: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        body_base64: body.toString("base64"),
      })],
      published_at: null,
      created_at: now,
      updated_at: now,
    });
    try {
      await this.store.create(draft);
    } catch (error) {
      if (isSkillDraftNameConflict(error)) throw new HttpError(409, "conflict", `A Skill draft already targets '${name}'`);
      throw error;
    }
    return draft;
  }

  async createDraftForEditing(name: string, description: string): Promise<SkillDraft> {
    const existing = (await this.store.list()).find((draft) => draft.name === name) ?? null;
    if (existing) throw new HttpError(409, "conflict", `A Skill draft already targets '${name}'`);
    const bundle = await this.library.getPublishedSkillBundle(name);
    return bundle ? this.createDraftFromPublishedBundle(bundle) : this.createDraft(name, description);
  }

  async ensureDraftForPublishedSkill(name: string): Promise<SkillDraft> {
    const normalized = name.trim();
    const existing = (await this.store.list()).find((draft) => draft.name === normalized) ?? null;
    if (existing) return existing;
    const bundle = await this.library.getPublishedSkillBundle(normalized);
    if (!bundle) throw new HttpError(404, "not_found", `Published Skill '${normalized}' does not exist`);
    return this.createDraftFromPublishedBundle(bundle);
  }

  private async createDraftFromPublishedBundle(
    bundle: NonNullable<Awaited<ReturnType<SkillLibraryService["getPublishedSkillBundle"]>>>,
  ): Promise<SkillDraft> {
    const skillMarkdown = bundle.files.find((file) => file.relativePath === "SKILL.md");
    if (!skillMarkdown) throw new HttpError(409, "conflict", `Published Skill '${bundle.name}' bundle has no SKILL.md`);
    const parsed = parseSkillMarkdown(Buffer.from(skillMarkdown.body).toString("utf8"));
    if (!parsed) throw new HttpError(409, "conflict", `Published Skill '${bundle.name}' SKILL.md is invalid`);
    const content = SkillDraftContentSchema.parse({
      name: bundle.name,
      description: bundle.description,
      content: bundle.content,
    });
    const now = new Date().toISOString();
    const draft = SkillDraftSchema.parse({
      id: `skill_draft_${randomUUID().replaceAll("-", "")}`,
      ...content,
      revision: 1,
      status: "published",
      source_session_id: null,
      source_agent_name: null,
      skill_metadata: bundle.metadata ?? parsed.metadata,
      bundle_assets: bundle.files.map((file) => {
        const body = Buffer.from(file.body);
        return SkillDraftAssetSchema.parse({
          relative_path: file.relativePath,
          media_type: file.mediaType || workspaceMediaType(file.relativePath),
          size: body.byteLength,
          sha256: createHash("sha256").update(body).digest("hex"),
          body_base64: body.toString("base64"),
        });
      }),
      published_at: now,
      created_at: now,
      updated_at: now,
    });
    try {
      await this.store.create(draft);
      return draft;
    } catch (error) {
      if (!isSkillDraftNameConflict(error)) throw error;
      const concurrent = (await this.store.list()).find((item) => item.name === bundle.name) ?? null;
      if (concurrent) return concurrent;
      throw new HttpError(409, "conflict", `A Skill draft already targets '${bundle.name}'`);
    }
  }

  async materializeDraftToWorkspace(
    draftOrId: SkillDraft | string,
    workspaceRoot: string,
  ): Promise<{ draft: SkillDraft; workspacePath: string }> {
    const draft = typeof draftOrId === "string" ? await this.getDraft(draftOrId) : draftOrId;
    const workspacePath = skillDraftWorkspacePath(workspaceRoot, draft.id);
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(workspacePath, { recursive: true });
    await writeWorkspaceJson(workspacePath, "manifest.json", {
      kind: "skill",
      draft_id: draft.id,
      expected_revision: draft.revision,
      name: draft.name,
    });
    for (const asset of draft.bundle_assets) {
      const relativePath = normalizeBundlePath(asset.relative_path);
      if (!relativePath || relativePath !== asset.relative_path) {
        throw new HttpError(409, "conflict", `Skill draft contains an unsafe file path: ${asset.relative_path}`);
      }
      const target = path.resolve(workspacePath, relativePath);
      if (!isPathUnder(target, workspacePath)) {
        throw new HttpError(409, "conflict", `Skill draft file path escapes its workspace: ${asset.relative_path}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(asset.body_base64, "base64"));
    }
    return { draft, workspacePath };
  }

  async publishWorkspaceDraft(
    draftId: string,
    workspaceRoot: string,
  ): Promise<{ draft: SkillDraft; published: boolean; workspacePath: string }> {
    const current = await this.getDraft(draftId);
    const workspacePath = skillDraftWorkspacePath(workspaceRoot, draftId);
    const manifest = parseSkillWorkspaceManifest(await readWorkspaceJson(workspacePath, "manifest.json"));
    if (manifest.draft_id !== draftId) throw new HttpError(409, "conflict", "Workspace manifest draft_id does not match the requested draft");
    assertRevision(current, manifest.expected_revision);
    const bundle = await readSkillWorkspaceBundle(workspacePath);
    const parsed = parseSkillMarkdown(bundle.skillMarkdown.toString("utf8"));
    if (!parsed) throw new HttpError(422, "validation_failed", "SKILL.md frontmatter 无效");
    const content = SkillDraftContentSchema.parse({
      name: parsed.name || current.name,
      description: parsed.description || current.description,
      content: parsed.content,
    });
    if (current.published_at !== null && content.name !== current.name) {
      throw new HttpError(409, "conflict", "Published Skill names are immutable; create a separate Draft for a rename");
    }
    const candidate = SkillDraftSchema.parse({
      ...current,
      ...content,
      revision: current.revision,
      status: "draft",
      published_at: current.published_at,
      skill_metadata: parsed.metadata,
      bundle_assets: bundle.assets,
      updated_at: new Date().toISOString(),
    });
    const approval = this.systemConfig
      ? resolveSkillsApprovalConfig(this.systemConfig.getSection("skills"))
      : { auto_publish_candidates: false };
    let published: SkillDraft;
    if (approval.auto_publish_candidates) {
      published = await this.publishWorkspaceCandidate(current, candidate);
    } else {
      published = SkillDraftSchema.parse({ ...candidate, revision: current.revision + 1 });
      if (!await this.store.update(current.revision, published)) {
        throw revisionConflict(current.revision, await this.getDraft(draftId));
      }
    }
    await this.materializeDraftToWorkspace(published, workspaceRoot);
    return {
      draft: published,
      published: published.status === "published",
      workspacePath: skillDraftWorkspacePath(workspaceRoot, published.id),
    };
  }

  async listDraftViews(): Promise<SkillDraftView[]> {
    return this.attachPackageStates(await this.listDrafts());
  }

  async getDraftView(id: string): Promise<SkillDraftView> {
    const [view] = await this.attachPackageStates([await this.getDraft(id)]);
    return view!;
  }

  async getDraftFile(id: string, relativePath: string): Promise<SkillDraft["bundle_assets"][number]> {
    const normalized = requireBundlePath(relativePath);
    const draft = await this.getDraft(id);
    const asset = draft.bundle_assets.find((candidate) => candidate.relative_path === normalized);
    if (!asset) throw new HttpError(404, "not_found", `Skill draft file '${normalized}' does not exist`);
    return asset;
  }

  async putDraftFile(
    id: string,
    expectedRevision: number,
    input: { relative_path: string; media_type?: string | undefined; body_base64: string },
  ): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    const relativePath = requireBundlePath(input.relative_path);
    const body = decodeBase64Body(input.body_base64, relativePath);
    const existingIndex = current.bundle_assets.findIndex(
      (asset) => asset.relative_path.toLowerCase() === relativePath.toLowerCase(),
    );
    const asset = SkillDraftAssetSchema.parse({
      relative_path: relativePath,
      media_type: input.media_type?.trim() || workspaceMediaType(relativePath),
      size: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      body_base64: body.toString("base64"),
    });
    const bundleAssets = [...current.bundle_assets];
    if (existingIndex >= 0) bundleAssets[existingIndex] = asset;
    else bundleAssets.push(asset);
    assertDraftBundle(bundleAssets);

    let content: SkillDraftContent = {
      name: current.name,
      description: current.description,
      content: current.content,
    };
    let skillMetadata = current.skill_metadata;
    if (relativePath === "SKILL.md") {
      const parsed = parseSkillMarkdown(body.toString("utf8"));
      if (!parsed) throw new HttpError(422, "validation_failed", "SKILL.md frontmatter is invalid");
      content = SkillDraftContentSchema.parse({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
      });
      skillMetadata = parsed.metadata;
      if (current.published_at !== null && content.name !== current.name) {
        throw new HttpError(409, "conflict", "Published Skill names are immutable; create a separate Draft for a rename");
      }
    }

    const candidate = SkillDraftSchema.parse({
      ...current,
      ...content,
      revision: current.revision,
      status: "draft",
      skill_metadata: skillMetadata,
      bundle_assets: bundleAssets,
      updated_at: new Date().toISOString(),
    });
    return this.saveDraftCandidate(current, candidate);
  }

  async deleteDraftFile(id: string, expectedRevision: number, relativePath: string): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    const normalized = requireBundlePath(relativePath);
    if (normalized === "SKILL.md") {
      throw new HttpError(422, "validation_failed", "Skill draft must contain root-level SKILL.md");
    }
    const bundleAssets = current.bundle_assets.filter((asset) => asset.relative_path !== normalized);
    if (bundleAssets.length === current.bundle_assets.length) {
      throw new HttpError(404, "not_found", `Skill draft file '${normalized}' does not exist`);
    }
    assertDraftBundle(bundleAssets);
    const candidate = SkillDraftSchema.parse({
      ...current,
      revision: current.revision,
      status: "draft",
      bundle_assets: bundleAssets,
      updated_at: new Date().toISOString(),
    });
    return this.saveDraftCandidate(current, candidate);
  }

  async deleteDraft(id: string): Promise<{ id: string }> {
    await this.getDraft(id);
    if (!await this.store.delete(id)) throw new HttpError(404, "not_found", `Skill draft '${id}' does not exist`);
    return { id };
  }

  async updateDraft(id: string, expectedRevision: number, input: SkillDraftContent): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    const content = SkillDraftContentSchema.parse(input);
    if (current.published_at !== null && content.name !== current.name) {
      throw new HttpError(409, "conflict", "Published Skill names are immutable; create a separate Draft for a rename");
    }

    const skillAssetIndex = current.bundle_assets.findIndex((asset) => asset.relative_path === "SKILL.md");
    if (skillAssetIndex < 0) throw new HttpError(409, "conflict", "Skill Draft bundle 缺少 SKILL.md");
    const skillAsset = current.bundle_assets[skillAssetIndex]!;
    const skillMarkdown = updateSkillMarkdown(
      Buffer.from(skillAsset.body_base64, "base64").toString("utf8"),
      content.name,
      content.description,
      content.content,
    );
    const body = Buffer.from(skillMarkdown, "utf8");
    const bundleAssets = [...current.bundle_assets];
    bundleAssets[skillAssetIndex] = SkillDraftAssetSchema.parse({
      ...skillAsset,
      size: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      body_base64: body.toString("base64"),
    });
    const candidate = SkillDraftSchema.parse({
      ...current,
      ...content,
      revision: current.revision,
      status: "draft",
      bundle_assets: bundleAssets,
      updated_at: new Date().toISOString(),
    });

    return this.saveDraftCandidate(current, candidate);
  }

  private async saveDraftCandidate(current: SkillDraft, candidate: SkillDraft): Promise<SkillDraft> {
    if (this.isAutoPublishEnabled()) return this.publishWorkspaceCandidate(current, candidate);
    const updated = SkillDraftSchema.parse({ ...candidate, revision: current.revision + 1 });
    try {
      if (!await this.store.update(current.revision, updated)) {
        throw revisionConflict(current.revision, await this.getDraft(current.id));
      }
    } catch (error) {
      if (isSkillDraftNameConflict(error)) throw new HttpError(409, "conflict", `A Skill draft already targets '${candidate.name}'`);
      throw error;
    }
    return updated;
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
      return this.materializePublishedDraft(current, true, false, current.published_at);
    }
    const ownsPublishedPackage = current.published_at !== null;
    const replacesPublishedPackage = packageState === "conflict" && ownsPublishedPackage;
    const alreadyMaterialized = packageState === "matching" && ownsPublishedPackage;
    if (packageState !== "absent" && !replacesPublishedPackage && !alreadyMaterialized) {
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

    if (alreadyMaterialized) return published;
    return this.materializePublishedDraft(published, false, replacesPublishedPackage, current.published_at);
  }

  private async publishWorkspaceCandidate(current: SkillDraft, candidate: SkillDraft): Promise<SkillDraft> {
    const packageState = await this.inspectPackage(candidate);
    const ownsPublishedPackage = current.published_at !== null;
    if (current.status === "published"
      && packageState === "matching"
      && sameSkillDraftContent(current, candidate)) return current;
    const replacesPublishedPackage = packageState === "conflict" && ownsPublishedPackage;
    const alreadyMaterialized = packageState === "matching" && ownsPublishedPackage;
    if (packageState !== "absent" && !replacesPublishedPackage && !alreadyMaterialized) {
      throw new HttpError(409, "conflict", `Skill '${candidate.name}' already exists; publishing will not overwrite it`);
    }

    const publishedAt = new Date().toISOString();
    const published = SkillDraftSchema.parse({
      ...candidate,
      revision: current.revision + 1,
      status: "published",
      published_at: publishedAt,
      updated_at: publishedAt,
    });
    if (!await this.store.update(current.revision, published)) {
      throw revisionConflict(current.revision, await this.getDraft(current.id));
    }
    if (alreadyMaterialized) return published;
    return this.materializePublishedDraft(published, false, replacesPublishedPackage, current.published_at);
  }

  private isAutoPublishEnabled(): boolean {
    if (!this.systemConfig) return false;
    return resolveSkillsApprovalConfig(
      this.systemConfig.getSection("skills"),
    ).auto_publish_candidates;
  }

  private async materializePublishedDraft(
    current: SkillDraft,
    acquireRepairRevision: boolean,
    replaceExisting = false,
    rollbackPublishedAt: string | null = null,
  ): Promise<SkillDraft> {
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
        throw new HttpError(409, "conflict", "该 Skill Draft 没有完整 bundle，不能发布");
      }
      const files = materializeBundleFiles(promoted);
      const bundle = {
        name: promoted.name,
        description: promoted.description,
        content: promoted.content,
        files,
        metadata: {
          ...promoted.skill_metadata,
        },
      };
      if (replaceExisting) await this.library.replaceSkillBundle(bundle);
      else await this.library.createSkillBundle(bundle);
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
        await this.rollbackPromotion(promoted, rollbackPublishedAt);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Skill publish failed and rollback was incomplete");
      }
      throw error;
    }
  }

  private async rollbackPromotion(promoted: SkillDraft, publishedAt: string | null): Promise<void> {
    const latest = await this.store.get(promoted.id);
    // Another publisher acquired a newer revision and now owns recovery.
    if (!latest || latest.status !== "published" || latest.revision !== promoted.revision) return;
    const reverted = SkillDraftSchema.parse({
      ...latest,
      revision: latest.revision + 1,
      status: "draft",
      published_at: publishedAt,
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

  /** Remove a published package while keeping its Draft editable. */
  async restoreDraftAfterSkillDelete(name: string): Promise<SkillDraft | null> {
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

function skillDraftWorkspacePath(workspaceRoot: string, draftId: string): string {
  const root = workspaceRoot.trim();
  if (!root) throw new HttpError(409, "conflict", "Current Agent Session has no workspace");
  return path.join(path.resolve(root), ".ragsystem", "skill-builder", "drafts", draftId);
}

async function writeWorkspaceJson(workspacePath: string, fileName: string, value: unknown): Promise<void> {
  await writeFile(path.join(workspacePath, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readWorkspaceJson(workspacePath: string, fileName: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, fileName), "utf8"));
  } catch (error) {
    throw new HttpError(422, "validation_failed", `${fileName} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseSkillWorkspaceManifest(value: unknown): { draft_id: string; expected_revision: number } {
  if (!isRecord(value)
    || typeof value.draft_id !== "string" || !value.draft_id.trim()
    || typeof value.expected_revision !== "number" || !Number.isInteger(value.expected_revision) || value.expected_revision < 1) {
    throw new HttpError(422, "validation_failed", "manifest.json requires draft_id and expected_revision");
  }
  return { draft_id: value.draft_id, expected_revision: value.expected_revision };
}

async function readSkillWorkspaceBundle(workspacePath: string): Promise<{
  assets: SkillDraft["bundle_assets"];
  skillMarkdown: Buffer;
}> {
  const files: Array<{ relativePath: string; body: Buffer }> = [];
  const seenPaths = new Set<string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === "manifest.json") continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = normalizeBundlePath(relativePath);
      if (!normalized) throw new HttpError(422, "validation_failed", `Invalid Skill file path: ${relativePath}`);
      const pathKey = normalized.toLowerCase();
      if (seenPaths.has(pathKey)) throw new HttpError(422, "validation_failed", `Duplicate Skill file path: ${normalized}`);
      seenPaths.add(pathKey);
      const fileStat = await stat(absolutePath);
      if (fileStat.size > 50 * 1024 * 1024) throw new HttpError(413, "payload_too_large", `Skill file is too large: ${relativePath}`);
      files.push({ relativePath: normalized, body: await readFile(absolutePath) });
      if (files.length > 256) throw new HttpError(422, "validation_failed", "A Skill draft cannot contain more than 256 files");
    }
  };
  await walk(workspacePath, "");
  const totalBytes = files.reduce((total, file) => total + file.body.byteLength, 0);
  if (totalBytes > 50 * 1024 * 1024) throw new HttpError(413, "payload_too_large", "Skill draft total size cannot exceed 50MB");
  const skillMarkdown = files.find((file) => file.relativePath === "SKILL.md")?.body;
  if (!skillMarkdown) throw new HttpError(422, "validation_failed", "Skill draft must contain root-level SKILL.md");
  return {
    skillMarkdown,
    assets: files.map((file) => SkillDraftAssetSchema.parse({
      relative_path: file.relativePath,
      media_type: workspaceMediaType(file.relativePath),
      size: file.body.byteLength,
      sha256: createHash("sha256").update(file.body).digest("hex"),
      body_base64: file.body.toString("base64"),
    })),
  };
}

function workspaceMediaType(filePath: string): string {
  const mediaTypes: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".py": "text/x-python; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ts": "text/typescript; charset=utf-8",
  };
  return mediaTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
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
      throw new HttpError(409, "conflict", `Skill Draft 文件校验失败: ${asset.relative_path}`);
    }
    return { relativePath: asset.relative_path, mediaType: asset.media_type, body };
  });
  const skillMdIndex = files.findIndex((file) => file.relativePath === "SKILL.md");
  if (skillMdIndex < 0) throw new HttpError(409, "conflict", "Skill Draft bundle 缺少 SKILL.md");
  const originalSkillMd = files[skillMdIndex]!;
  const parsedOriginal = parseSkillMarkdown(originalSkillMd.body.toString("utf8"));
  if (!parsedOriginal) throw new HttpError(409, "conflict", "Skill Draft 的 SKILL.md 无法解析");
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

function requireBundlePath(value: string): string {
  const normalized = normalizeBundlePath(value);
  if (!normalized) throw new HttpError(422, "validation_failed", `Invalid Skill file path: ${value}`);
  return normalized;
}

function decodeBase64Body(value: string, relativePath: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(422, "validation_failed", `Skill file '${relativePath}' body_base64 is invalid`);
  }
  const body = Buffer.from(value, "base64");
  if (body.byteLength === 0 || body.byteLength > 50 * 1024 * 1024) {
    throw new HttpError(413, "payload_too_large", `Skill file '${relativePath}' must be between 1 byte and 50MB`);
  }
  return body;
}

function assertDraftBundle(assets: SkillDraft["bundle_assets"]): void {
  if (assets.length > 256) throw new HttpError(422, "validation_failed", "A Skill draft cannot contain more than 256 files");
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const asset of assets) {
    const relativePath = requireBundlePath(asset.relative_path);
    if (relativePath !== asset.relative_path) {
      throw new HttpError(422, "validation_failed", `Skill file path must be normalized: ${asset.relative_path}`);
    }
    const key = relativePath.toLowerCase();
    if (seen.has(key)) throw new HttpError(422, "validation_failed", `Duplicate Skill file path: ${relativePath}`);
    seen.add(key);
    const body = decodeBase64Body(asset.body_base64, relativePath);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (asset.size !== body.byteLength || asset.sha256 !== sha256) {
      throw new HttpError(422, "validation_failed", `Skill file checksum is invalid: ${relativePath}`);
    }
    totalBytes += body.byteLength;
  }
  if (!assets.some((asset) => asset.relative_path === "SKILL.md")) {
    throw new HttpError(422, "validation_failed", "Skill draft must contain root-level SKILL.md");
  }
  if (totalBytes > 50 * 1024 * 1024) throw new HttpError(413, "payload_too_large", "Skill draft total size cannot exceed 50MB");
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type PackageState = "absent" | "matching" | "conflict";

function sameSkillDraftContent(left: SkillDraft, right: SkillDraft): boolean {
  if (left.name !== right.name
    || left.description !== right.description
    || left.content !== right.content
    || !isDeepStrictEqual(left.skill_metadata, right.skill_metadata)
    || left.bundle_assets.length !== right.bundle_assets.length) return false;

  const leftAssets = new Map(left.bundle_assets.map((asset) => [asset.relative_path, asset]));
  return right.bundle_assets.every((asset) => isDeepStrictEqual(leftAssets.get(asset.relative_path), asset));
}

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

import { randomUUID } from "node:crypto";

import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

import {
  isSkillDraftNameConflict,
  SkillDraftContentSchema,
  SkillDraftSchema,
  type SkillDraft,
  type SkillDraftContent,
  type SkillDraftView,
  type SkillDraftStore,
} from "../contracts/skills/skill-draft.js";
import type { SkillLibraryService } from "./skill-library-service.js";

export interface SkillDraftSource {
  sessionId?: string | null;
  agentName?: string | null;
}

/** Owns Skill draft revisions and promotes approved drafts through SkillLibraryService. */
export class SkillAuthoringService {
  constructor(
    private readonly store: SkillDraftStore,
    private readonly library: SkillLibraryService,
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

  async createDraft(input: SkillDraftContent, source: SkillDraftSource = {}): Promise<SkillDraft> {
    const content = SkillDraftContentSchema.parse(input);
    const duplicate = (await this.store.list()).find(
      (draft) => draft.name === content.name,
    );
    if (duplicate) {
      throw new HttpError(409, "conflict", `Skill draft '${duplicate.id}' already targets '${content.name}'`);
    }
    const now = new Date().toISOString();
    const draft = SkillDraftSchema.parse({
      ...content,
      id: `skill_draft_${randomUUID().replaceAll("-", "")}`,
      revision: 1,
      status: "draft",
      source_session_id: source.sessionId?.trim() || null,
      source_agent_name: source.agentName?.trim() || null,
      published_at: null,
      created_at: now,
      updated_at: now,
    });
    try {
      await this.store.create(draft);
    } catch (error) {
      if (isSkillDraftNameConflict(error)) {
        throw new HttpError(409, "conflict", `A Skill draft already targets '${content.name}'`);
      }
      throw error;
    }
    return draft;
  }

  async updateDraft(id: string, expectedRevision: number, input: SkillDraftContent): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    if (current.status === "published") {
      throw new HttpError(409, "conflict", "Published Skill drafts are immutable; manage the formal Skill in the Skill Library");
    }
    const updated = SkillDraftSchema.parse({
      ...current,
      ...SkillDraftContentSchema.parse(input),
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    });
    try {
      if (!await this.store.update(current.revision, updated)) {
        throw revisionConflict(expectedRevision, await this.getDraft(id));
      }
    } catch (error) {
      if (isSkillDraftNameConflict(error)) {
        throw new HttpError(409, "conflict", `A Skill draft already targets '${updated.name}'`);
      }
      throw error;
    }
    return updated;
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

  /** Reopen the published snapshot after its formal Skill package is deleted. */
  async restoreDraftAfterSkillDelete(skillName: string): Promise<SkillDraft | null> {
    const normalizedName = skillName.trim();
    if (!normalizedName) return null;
    const current = (await this.store.list()).find(
      (draft) => draft.status === "published" && draft.name === normalizedName,
    );
    if (!current) return null;

    const reopened = SkillDraftSchema.parse({
      ...current,
      revision: current.revision + 1,
      status: "draft",
      published_at: null,
      updated_at: new Date().toISOString(),
    });
    if (await this.store.update(current.revision, reopened)) return reopened;

    // A concurrent delete may already have reopened the same draft. Treat that
    // outcome as idempotent; a different published revision remains a conflict.
    const latest = await this.store.get(current.id);
    if (latest?.name === normalizedName && latest.status === "draft") return latest;
    if (latest) throw revisionConflict(current.revision, latest);
    return null;
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
      await this.library.createSkill({
        name: promoted.name,
        description: promoted.description,
        content: promoted.content,
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
    return detail.source_type === "user_global"
      && detail.description === draft.description
      && detail.content === draft.content
      ? "matching"
      : "conflict";
  }

  private async attachPackageStates(drafts: SkillDraft[]): Promise<SkillDraftView[]> {
    if (!drafts.some((draft) => draft.status === "published")) {
      return drafts.map((draft) => ({ ...draft, package_state: "not_published" }));
    }
    let sources: Map<string, string>;
    try {
      sources = new Map((await this.library.listSkills()).map((skill) => [skill.name, skill.source_type]));
    } catch {
      return drafts.map((draft) => ({
        ...draft,
        package_state: draft.status === "published" ? "unknown" : "not_published",
      }));
    }
    return drafts.map((draft) => {
      if (draft.status !== "published") return { ...draft, package_state: "not_published" };
      const source = sources.get(draft.name);
      const packageState = source === undefined ? "missing" : source === "user_global" ? "available" : "conflict";
      return { ...draft, package_state: packageState };
    });
  }
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

import { randomUUID } from "node:crypto";

import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

import {
  SkillDraftContentSchema,
  SkillDraftSchema,
  type SkillDraft,
  type SkillDraftContent,
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

  async createDraft(input: SkillDraftContent, source: SkillDraftSource = {}): Promise<SkillDraft> {
    const content = SkillDraftContentSchema.parse(input);
    const duplicate = (await this.store.list()).find(
      (draft) => draft.status === "draft" && draft.name === content.name,
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
    await this.store.create(draft);
    return draft;
  }

  async updateDraft(id: string, expectedRevision: number, input: SkillDraftContent): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    if (current.status === "published") {
      throw new HttpError(409, "conflict", "Published Skill drafts are immutable; create a new draft instead");
    }
    const updated = SkillDraftSchema.parse({
      ...current,
      ...SkillDraftContentSchema.parse(input),
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    });
    if (!await this.store.update(current.revision, updated)) {
      throw revisionConflict(expectedRevision, await this.getDraft(id));
    }
    return updated;
  }

  async publishDraft(id: string, expectedRevision: number): Promise<SkillDraft> {
    const current = await this.getDraft(id);
    assertRevision(current, expectedRevision);
    if (current.status === "published") return current;
    if ((await this.library.listSkills()).some((skill) => skill.name === current.name)) {
      throw new HttpError(409, "conflict", `Skill '${current.name}' already exists; publishing will not overwrite it`);
    }

    await this.library.createSkill({
      name: current.name,
      description: current.description,
      content: current.content,
    });
    const publishedAt = new Date().toISOString();
    const published = SkillDraftSchema.parse({
      ...current,
      revision: current.revision + 1,
      status: "published",
      published_at: publishedAt,
      updated_at: publishedAt,
    });
    try {
      if (!await this.store.update(current.revision, published)) {
        throw revisionConflict(expectedRevision, await this.getDraft(id));
      }
      return published;
    } catch (error) {
      try {
        await this.library.deleteSkill(current.name);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Skill publish failed and rollback was incomplete");
      }
      throw error;
    }
  }
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

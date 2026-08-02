import type { AgentDraft, AgentRelease } from "./contracts.js";

export interface AgentBuilderStore {
  listDrafts(): Promise<AgentDraft[]>;
  getDraft(id: string): Promise<AgentDraft | null>;
  putDraft(draft: AgentDraft): Promise<void>;
  listReleases(packageName?: string): Promise<AgentRelease[]>;
  getRelease(id: string): Promise<AgentRelease | null>;
  createRelease(release: AgentRelease): Promise<void>;
  deleteRelease(id: string): Promise<void>;
}

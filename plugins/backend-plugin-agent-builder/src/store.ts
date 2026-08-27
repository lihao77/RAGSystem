import type { AgentDraft } from "./contracts.js";

export interface AgentBuilderStore {
  listDrafts(): Promise<AgentDraft[]>;
  getDraft(id: string): Promise<AgentDraft | null>;
  putDraft(draft: AgentDraft): Promise<void>;
  /** 已归档的历史 revision 号（降序）；无历史时为空。 */
  listRevisions(id: string): Promise<number[]>;
  getRevision(id: string, revision: number): Promise<AgentDraft | null>;
  deleteDraft(id: string): Promise<void>;
}

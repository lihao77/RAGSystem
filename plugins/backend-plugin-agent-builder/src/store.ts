import type { AgentDraft } from "./contracts.js";

export interface AgentBuilderStore {
  listDrafts(): Promise<AgentDraft[]>;
  getDraft(id: string): Promise<AgentDraft | null>;
  putDraft(draft: AgentDraft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
}

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";

/** Shared ports for runtime tools. Implementations belong to deployment adapters. */
export interface DocumentToolPort {
  readFile: (...args: any[]) => any;
  writeFile: (...args: any[]) => Promise<ToolExecutionResult>;
  editFile: (...args: any[]) => Promise<ToolExecutionResult>;
  previewDataStructure: (...args: any[]) => any;
  getExternalCandidates: (...args: any[]) => string[];
}

/** Records the pre-edit state before a document tool mutates a local file. */
export interface DocumentEditHistoryPort {
  trackEdit(sessionId: string | null | undefined, filePath: string): Promise<void>;
}

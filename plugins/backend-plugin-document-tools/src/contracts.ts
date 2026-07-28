export interface DocumentToolPort {
  readFile: (...args: any[]) => any;
  writeFile: (...args: any[]) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
  editFile: (...args: any[]) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
  previewDataStructure: (...args: any[]) => any;
  getExternalCandidates: (...args: any[]) => string[];
}

/** Records pre-edit state before a document tool mutates a local file. */
export interface DocumentEditHistoryPort {
  trackEdit(sessionId: string | null | undefined, filePath: string): void | Promise<void>;
}

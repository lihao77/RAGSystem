export interface DocumentToolPort {
  readFile: (...args: any[]) => any;
  writeFile: (...args: any[]) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
  editFile: (...args: any[]) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
  previewDataStructure: (...args: any[]) => any;
  getExternalCandidates: (...args: any[]) => string[];
}

/** @deprecated Use the deployment-neutral Core file history port. */
export type { FileEditHistoryPort as DocumentEditHistoryPort } from "@ragsystem/backend-core/contracts/file-history-store/index.js";

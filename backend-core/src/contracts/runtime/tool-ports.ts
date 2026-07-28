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

export interface CommandExecutionPort {
  buildCommandClassification: (...args: any[]) => any;
  getExternalCandidates: (...args: any[]) => string[];
  prepareExecution: (...args: any[]) => any;
  executePlan: (...args: any[]) => any;
}

export interface WorkspaceSearchPort {
  glob: (...args: any[]) => any;
  grep: (...args: any[]) => any;
  webFetch: (...args: any[]) => any;
  todoWrite: (...args: any[]) => any;
}

export interface CodeExecutionPort {
  executeCode: (...args: any[]) => any;
  setToolCaller: (caller: ((toolName: string, args: Record<string, unknown>, context: ToolExecContext) => Promise<ToolExecutionResult>) | null) => void;
}

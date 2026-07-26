import type { TenantId } from "../../identity/types.js";

/** Identity boundary attached to one disposable sandbox. */
export interface SandboxOwner {
  tenantId: TenantId;
  userId: string;
  sessionId: string;
  runId: string;
}

export interface SandboxLease {
  /** Provider-private identifier. It must never be returned in a tool result. */
  id: string;
  owner: SandboxOwner;
  createdAt: string;
  expiresAt?: string | null;
}

export interface SandboxFileReadResult {
  content: string;
  size: number;
}

export interface SandboxFileWriteResult {
  size: number;
}

export interface SandboxFileEditResult extends SandboxFileWriteResult {
  replacements: number;
}

export interface SandboxGlobResult {
  files: string[];
  truncated: boolean;
}

export interface SandboxGrepMatch {
  file: string;
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

export interface SandboxGrepResult {
  matches: SandboxGrepMatch[];
  scannedFiles: number;
  truncated: boolean;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  returnCode: number;
  interrupted: boolean;
  truncated?: boolean;
}

export interface SandboxCodeResult extends SandboxExecResult {
  result: unknown;
}

export interface SandboxPreviewResult {
  fileType: string;
  fileSize: number;
  structure: Record<string, unknown>;
}

/**
 * Vendor-neutral data-plane contract.
 *
 * Security invariants are enforced by the provider, not merely requested by this client:
 * - each create call returns a fresh owner-bound sandbox and never reuses an active sandbox across owners;
 * - network="none" and the filesystem access modes are mandatory runtime restrictions;
 * - every file operation canonicalizes paths after symlink resolution and rejects mount/root escapes;
 * - exec/code processes cannot observe the host or another lease's processes, files, credentials, or metadata.
 */
export interface SandboxProvider {
  create(input: {
    owner: SandboxOwner;
    network: "none";
    timeoutSeconds: number;
    filesystem: {
      input: "read_only";
      work: "read_write";
      output: "read_write";
    };
  }): Promise<SandboxLease>;
  destroy(lease: SandboxLease): Promise<void>;
  readFile(lease: SandboxLease, input: {
    path: string;
    encoding: string;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxFileReadResult>;
  writeFile(lease: SandboxLease, input: {
    path: string;
    content: string;
    encoding: string;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxFileWriteResult>;
  editFile(lease: SandboxLease, input: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
    encoding: string;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxFileEditResult>;
  glob(lease: SandboxLease, input: {
    root: string;
    pattern: string;
    recursive: boolean;
    maxResults: number;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxGlobResult>;
  grep(lease: SandboxLease, input: {
    root: string;
    pattern: string;
    glob: string;
    caseSensitive: boolean;
    maxResults: number;
    contextLines: number;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxGrepResult>;
  previewFile(lease: SandboxLease, input: {
    path: string;
    encoding: string;
    maxPreviewRows: number;
    maxDepth: number;
    maxFields: number;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxPreviewResult>;
  exec(lease: SandboxLease, input: {
    command: string;
    cwd: string;
    timeoutSeconds: number;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxExecResult>;
  executeCode(lease: SandboxLease, input: {
    code: string;
    cwd: string;
    timeoutSeconds: number;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxCodeResult>;
}

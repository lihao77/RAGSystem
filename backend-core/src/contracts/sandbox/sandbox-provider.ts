import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { TenantId } from "../../identity/types.js";

/** Identity boundary attached to one disposable sandbox. */
export interface SandboxOwner {
  tenantId: TenantId;
  userId: string;
  sessionId: string;
  runId: string;
}

export interface SandboxLease {
  /** Driver-private identifier. It must never be returned in a tool result. */
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
 * Security invariants are enforced by the driver, not merely requested by this client:
 * - each create call returns a fresh owner-bound sandbox and never reuses an active sandbox across owners;
 * - network="none" and the filesystem access modes are mandatory runtime restrictions;
 * - every file operation canonicalizes paths after symlink resolution and rejects mount/root escapes;
 * - exec/code processes cannot observe the host or another lease's processes, files, credentials, or metadata.
 */
export interface SandboxDriver {
  create(input: {
    owner: SandboxOwner;
    network: "none";
    timeoutSeconds: number;
    filesystem: {
      input: "read_only";
      work: "read_write";
    };
  }): Promise<SandboxLease>;
  destroy(lease: SandboxLease): Promise<void>;
  /** Privileged control-plane copy into the otherwise read-only input mount. */
  stageInputFile(lease: SandboxLease, input: {
    path: string;
    content: string;
    encoding: "base64";
    contentType: string;
  }): Promise<SandboxFileWriteResult>;
  readFile(lease: SandboxLease, input: SandboxReadFileInput): Promise<SandboxFileReadResult>;
  writeFile(lease: SandboxLease, input: SandboxWriteFileInput): Promise<SandboxFileWriteResult>;
  editFile(lease: SandboxLease, input: SandboxEditFileInput): Promise<SandboxFileEditResult>;
  glob(lease: SandboxLease, input: SandboxGlobInput): Promise<SandboxGlobResult>;
  grep(lease: SandboxLease, input: SandboxGrepInput): Promise<SandboxGrepResult>;
  previewFile(lease: SandboxLease, input: SandboxPreviewFileInput): Promise<SandboxPreviewResult>;
  exec(lease: SandboxLease, input: SandboxExecInput): Promise<SandboxExecResult>;
  executeCode(lease: SandboxLease, input: SandboxCodeInput): Promise<SandboxCodeResult>;
}

/** Input accepted by a low-level sandbox driver for reading a file. */
export interface SandboxReadFileInput {
    path: string;
    encoding: string;
    /** Driver-enforced response limit. The driver must reject larger files before returning content. */
    maxBytes?: number | undefined;
    signal?: AbortSignal | undefined;
}

export interface SandboxWriteFileInput {
    path: string;
    content: string;
    encoding: string;
    signal?: AbortSignal | undefined;
}

export interface SandboxEditFileInput {
    path: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
    encoding: string;
    signal?: AbortSignal | undefined;
}

export interface SandboxGlobInput {
    /** Results must be file paths relative to this root, never absolute paths. */
    root: string;
    pattern: string;
    recursive: boolean;
    maxResults: number;
    signal?: AbortSignal | undefined;
}

export interface SandboxGrepInput {
    root: string;
    pattern: string;
    glob: string;
    caseSensitive: boolean;
    maxResults: number;
    contextLines: number;
    signal?: AbortSignal | undefined;
}

export interface SandboxPreviewFileInput {
    path: string;
    encoding: string;
    maxBytes: number;
    maxPreviewRows: number;
    maxDepth: number;
    maxFields: number;
    signal?: AbortSignal | undefined;
}

export interface SandboxExecInput {
    command: string;
    cwd: string;
    timeoutSeconds: number;
    signal?: AbortSignal | undefined;
}

export interface SandboxCodeInput {
    code: string;
    cwd: string;
    timeoutSeconds: number;
    signal?: AbortSignal | undefined;
}

/** Tenant/run-scoped sandbox operations exposed to feature plugins. */
export interface RunSandboxRuntime {
  readFile(context: ToolExecContext, input: Omit<SandboxReadFileInput, "signal">): Promise<SandboxFileReadResult>;
  writeFile(context: ToolExecContext, input: Omit<SandboxWriteFileInput, "signal">): Promise<SandboxFileWriteResult>;
  editFile(context: ToolExecContext, input: Omit<SandboxEditFileInput, "signal">): Promise<SandboxFileEditResult>;
  glob(context: ToolExecContext, input: Omit<SandboxGlobInput, "signal">): Promise<SandboxGlobResult>;
  grep(context: ToolExecContext, input: Omit<SandboxGrepInput, "signal">): Promise<SandboxGrepResult>;
  previewFile(context: ToolExecContext, input: Omit<SandboxPreviewFileInput, "signal">): Promise<SandboxPreviewResult>;
  exec(context: ToolExecContext, input: Omit<SandboxExecInput, "signal">): Promise<SandboxExecResult>;
  executeCode(context: ToolExecContext, input: Omit<SandboxCodeInput, "signal">): Promise<SandboxCodeResult>;
  releaseRun(sessionId: string, runId: string, options?: { collectOutputs?: boolean }): Promise<void>;
  closeAll(): Promise<void>;
}

export interface SandboxLeaseLifecycle {
  prepare(
    lease: SandboxLease,
    owner: SandboxOwner,
    driver: SandboxDriver,
    input: { attachmentFileIds: readonly string[] },
  ): Promise<void>;
  collectOutputs(lease: SandboxLease, owner: SandboxOwner, driver: SandboxDriver): Promise<void>;
}

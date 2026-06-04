import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MemoryScopeName = "team" | "session" | "agent" | "workspace";

export interface MemoryScopeSpec {
  scope: MemoryScopeName;
  team_name?: string;
  session_id?: string;
  agent_name?: string;
  workspace_key?: string;
}

export interface MemoryStoreOptions {
  dataRoot?: string | undefined;
}

export interface MemoryIndexReadOptions {
  maxLines?: number | undefined;
  maxChars?: number | undefined;
}

export interface MemoryEntryFile {
  scope: MemoryScopeName;
  file_name: string;
  file_path: string;
  content: string;
}

const DEFAULT_INDEX_MAX_LINES = 200;
const DEFAULT_INDEX_MAX_CHARS = 25600;

export class MemoryStore {
  private readonly dataRoot: string;

  constructor(options: MemoryStoreOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot?.trim() || path.join(os.homedir(), ".ragsystem"));
  }

  getScopeRoot(scopeSpec: MemoryScopeSpec): string {
    const memoryRoot = path.join(this.dataRoot, "memory");
    if (scopeSpec.scope === "team") {
      return path.join(memoryRoot, "teams", scopeSpec.team_name ?? "");
    }
    if (scopeSpec.scope === "session") {
      return path.join(memoryRoot, "sessions", scopeSpec.session_id ?? "");
    }
    if (scopeSpec.scope === "agent") {
      return path.join(memoryRoot, "teams", scopeSpec.team_name ?? "", "agents", scopeSpec.agent_name ?? "");
    }
    return path.join(memoryRoot, "workspaces", scopeSpec.workspace_key ?? "");
  }

  getIndexPath(scopeSpec: MemoryScopeSpec): string {
    return path.join(this.getScopeRoot(scopeSpec), "MEMORY.md");
  }

  loadIndexHead(scopeSpec: MemoryScopeSpec, options: MemoryIndexReadOptions = {}): string {
    const maxLines = options.maxLines ?? DEFAULT_INDEX_MAX_LINES;
    const maxChars = options.maxChars ?? DEFAULT_INDEX_MAX_CHARS;
    try {
      const indexPath = this.getIndexPath(scopeSpec);
      if (!fs.existsSync(indexPath)) {
        return "";
      }
      const text = fs.readFileSync(indexPath, "utf8");
      const limited = text.split(/\r?\n/).slice(0, maxLines).join("\n");
      return limited.slice(0, maxChars).trim();
    } catch {
      return "";
    }
  }

  readEntryFile(scopeSpec: MemoryScopeSpec, fileName: string): MemoryEntryFile | null {
    const normalizedFileName = path.basename(fileName);
    if (!normalizedFileName || normalizedFileName === "MEMORY.md") {
      return null;
    }
    const filePath = path.join(this.getScopeRoot(scopeSpec), normalizedFileName);
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return {
        scope: scopeSpec.scope,
        file_name: normalizedFileName,
        file_path: filePath,
        content: fs.readFileSync(filePath, "utf8"),
      };
    } catch {
      return null;
    }
  }
}

export function getWorkspaceMemoryKey(workspaceRoot: string | null): string | null {
  if (!workspaceRoot) {
    return null;
  }
  const raw = workspaceRoot.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw
    .replace(/\\/g, "-")
    .replace(/\//g, "-")
    .replace(/:/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return normalized || "workspace";
}

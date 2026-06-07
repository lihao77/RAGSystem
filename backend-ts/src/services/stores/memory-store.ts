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

export interface MemoryEntry {
  name: string;
  description: string;
  scope: string;
  memory_type: string;
  status: string;
  file_name: string;
  file_path: string;
  updated_at: string;
  body: string;
}

export interface SaveMemoryInput extends MemoryScopeSpec {
  name: string;
  description: string;
  memory_type: string;
  content: string;
  why?: string | null | undefined;
  how_to_apply?: string | null | undefined;
  source_run_id?: string | null | undefined;
  source_message_id?: string | null | undefined;
  status?: string | null | undefined;
}

export interface SavedMemoryFile {
  file_name: string;
  file_path: string;
  scope: MemoryScopeName;
}

const DEFAULT_INDEX_MAX_LINES = 200;
const DEFAULT_INDEX_MAX_CHARS = 25600;
const ALLOWED_MEMORY_TYPES = new Set(["preference", "constraint", "goal", "fact", "profile"]);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class MemoryStore {
  private readonly dataRoot: string;

  constructor(options: MemoryStoreOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot?.trim() || path.join(os.homedir(), ".ragsystem"));
  }

  getScopeRoot(scopeSpec: MemoryScopeSpec): string {
    const memoryRoot = path.join(this.dataRoot, "memory");
    if (scopeSpec.scope === "team") {
      const teamName = normalizeString(scopeSpec.team_name);
      if (!teamName) {
        throw new Error("team scope 缺少 team_name");
      }
      return path.join(memoryRoot, "teams", teamName);
    }
    if (scopeSpec.scope === "session") {
      const sessionId = normalizeString(scopeSpec.session_id);
      if (!sessionId) {
        throw new Error("session scope 缺少 session_id");
      }
      return path.join(memoryRoot, "sessions", sessionId);
    }
    if (scopeSpec.scope === "agent") {
      const teamName = normalizeString(scopeSpec.team_name);
      if (!teamName) {
        throw new Error("agent scope 缺少 team_name");
      }
      const agentName = normalizeString(scopeSpec.agent_name);
      if (!agentName) {
        throw new Error("agent scope 缺少 agent_name");
      }
      return path.join(memoryRoot, "teams", teamName, "agents", agentName);
    }
    const workspaceKey = normalizeString(scopeSpec.workspace_key);
    if (!workspaceKey) {
      throw new Error("workspace scope 缺少 workspace_key");
    }
    return path.join(memoryRoot, "workspaces", workspaceKey);
  }

  getIndexPath(scopeSpec: MemoryScopeSpec): string {
    return path.join(this.getScopeRoot(scopeSpec), "MEMORY.md");
  }

  ensureScope(scopeSpec: MemoryScopeSpec): string {
    const scopeRoot = this.getScopeRoot(scopeSpec);
    fs.mkdirSync(scopeRoot, { recursive: true });
    const indexPath = path.join(scopeRoot, "MEMORY.md");
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, `# ${titleCase(scopeSpec.scope)} Memory\n\n`, "utf8");
    }
    return scopeRoot;
  }

  loadIndexHead(scopeSpec: MemoryScopeSpec, options: MemoryIndexReadOptions = {}): string {
    const maxLines = options.maxLines ?? DEFAULT_INDEX_MAX_LINES;
    const maxChars = options.maxChars ?? DEFAULT_INDEX_MAX_CHARS;
    try {
      const scopeRoot = this.ensureScope(scopeSpec);
      const indexPath = path.join(scopeRoot, "MEMORY.md");
      const text = fs.readFileSync(indexPath, "utf8");
      const limited = text.split(/\r?\n/).slice(0, maxLines).join("\n");
      return limited.slice(0, maxChars).trim();
    } catch {
      return "";
    }
  }

  readEntryFile(scopeSpec: MemoryScopeSpec, fileName: string): MemoryEntryFile | null {
    const normalizedFileName = path.basename(fileName);
    if (!normalizedFileName || normalizedFileName === "." || normalizedFileName === "..") {
      return null;
    }
    try {
      const scopeRoot = this.ensureScope(scopeSpec);
      const filePath = path.join(scopeRoot, normalizedFileName);
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

  saveMemory(input: SaveMemoryInput): SavedMemoryFile {
    const normalizedMemoryType = normalizeString(input.memory_type)?.toLowerCase() ?? "fact";
    if (!ALLOWED_MEMORY_TYPES.has(normalizedMemoryType)) {
      throw new Error(`不支持的 memory_type: ${input.memory_type}`);
    }

    const scopeRoot = this.ensureScope(input);
    const fileName = `${normalizedMemoryType}_${slugify(input.name)}.md`;
    const filePath = path.join(scopeRoot, fileName);
    const now = nowIso();
    const existing = fs.existsSync(filePath) ? readEntry(filePath) : null;
    const createdAt = existing?.updated_at || now;
    const bodyLines = [input.content.trim()];
    const why = normalizeString(input.why);
    if (why) {
      bodyLines.push("", `**Why:** ${why}`);
    }
    const howToApply = normalizeString(input.how_to_apply);
    if (howToApply) {
      bodyLines.push(`**How to apply:** ${howToApply}`);
    }
    const body = `${bodyLines.join("\n").trim()}\n`;
    const frontmatter: Record<string, string> = {
      name: input.name.trim(),
      description: input.description.trim(),
      type: input.scope,
      memory_type: normalizedMemoryType,
      status: normalizeString(input.status)?.toLowerCase() ?? "active",
      agent: input.agent_name?.trim() ?? "",
      session_id: input.session_id?.trim() ?? "",
      team_name: input.team_name?.trim() ?? "",
      created_at: createdAt,
      updated_at: now,
      source_run_id: input.source_run_id?.trim() ?? "",
      source_message_id: input.source_message_id?.trim() ?? "",
    };
    fs.writeFileSync(filePath, renderMarkdown(frontmatter, body), "utf8");
    this.rebuildIndex(input);
    return {
      file_name: fileName,
      file_path: filePath,
      scope: input.scope,
    };
  }

  listEntries(scopeSpec: MemoryScopeSpec, options: { includeArchived?: boolean | undefined } = {}): MemoryEntry[] {
    const scopeRoot = this.ensureScope(scopeSpec);
    const entries = fs
      .readdirSync(scopeRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md")
      .map((entry) => readEntry(path.join(scopeRoot, entry.name)))
      .filter((entry): entry is MemoryEntry => Boolean(entry))
      .filter((entry) => options.includeArchived || entry.status === "active");
    entries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return entries;
  }

  archiveMemory(scopeSpec: MemoryScopeSpec, fileName: string): boolean {
    const normalizedFileName = path.basename(fileName);
    if (!normalizedFileName || normalizedFileName === "." || normalizedFileName === "..") {
      return false;
    }

    const scopeRoot = this.ensureScope(scopeSpec);
    const filePath = path.join(scopeRoot, normalizedFileName);
    const entry = readEntry(filePath);
    if (!entry) {
      return false;
    }

    const text = fs.readFileSync(filePath, "utf8");
    if (!text.includes("status: active")) {
      return false;
    }
    fs.writeFileSync(filePath, text.replace("status: active", "status: archived"), "utf8");
    this.rebuildIndex(scopeSpec);
    return true;
  }

  private rebuildIndex(scopeSpec: MemoryScopeSpec): void {
    const scopeRoot = this.ensureScope(scopeSpec);
    const entries = this.listEntries(scopeSpec, { includeArchived: false });
    const lines = [`# ${titleCase(scopeSpec.scope)} Memory`, ""];
    if (entries.length) {
      lines.push("## Index", "");
      for (const entry of entries) {
        lines.push(`- [${entry.name}](${entry.file_name}) - ${entry.description}`);
      }
    } else {
      lines.push("暂无记忆。");
    }
    fs.writeFileSync(path.join(scopeRoot, "MEMORY.md"), `${lines.join("\n").trim()}\n`, "utf8");
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

function readEntry(filePath: string): MemoryEntry | null {
  if (!fs.existsSync(filePath) || path.basename(filePath) === "MEMORY.md") {
    return null;
  }
  const text = fs.readFileSync(filePath, "utf8");
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return null;
  }
  const metadata: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    metadata[key] = value;
  }
  return {
    name: metadata.name ?? path.basename(filePath, path.extname(filePath)),
    description: metadata.description ?? "",
    scope: metadata.type ?? "session",
    memory_type: metadata.memory_type ?? "fact",
    status: metadata.status ?? "active",
    file_name: path.basename(filePath),
    file_path: filePath,
    updated_at: metadata.updated_at ?? "",
    body: (match[2] ?? "").trim(),
  };
}

function renderMarkdown(frontmatter: Record<string, string>, body: string): string {
  return [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

function slugify(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/gu, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "memory";
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function titleCase(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

function normalizeString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

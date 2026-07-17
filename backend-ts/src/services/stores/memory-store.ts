import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withLeaseLockSync } from "@ragsystem/agent-sdk";

import type {
  IMemoryStore,
  MemoryEntry,
  MemoryEntryFile,
  MemoryIndexReadOptions,
  MemoryScopeName,
  MemoryScopeSpec,
  MemoryStoreOptions,
  SaveMemoryInput,
  SavedMemoryFile,
} from "../../contracts/memory-store/index.js";
import { SaveMemoryInputSchema } from "../../contracts/memory-store/types.js";

const DEFAULT_INDEX_MAX_LINES = 200;
const DEFAULT_INDEX_MAX_CHARS = 25600;
const ALLOWED_MEMORY_TYPES = new Set(["preference", "constraint", "goal", "fact", "profile"]);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class MemoryStore implements IMemoryStore {
  private readonly dataRoot: string;

  constructor(options: MemoryStoreOptions = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("MemoryStore 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
  }

  getScopeRoot(scopeSpec: MemoryScopeSpec): string {
    const memoryRoot = path.join(this.dataRoot, "memory");
    fs.mkdirSync(memoryRoot, { recursive: true });
    if (scopeSpec.scope === "team") {
      const teamName = normalizePathSegment(scopeSpec.team_name, "team_name");
      if (!teamName) {
        throw new Error("team scope 缺少 team_name");
      }
      return resolveScopePath(memoryRoot, "teams", teamName);
    }
    if (scopeSpec.scope === "session") {
      const sessionId = normalizePathSegment(scopeSpec.session_id, "session_id");
      if (!sessionId) {
        throw new Error("session scope 缺少 session_id");
      }
      return resolveScopePath(memoryRoot, "sessions", sessionId);
    }
    if (scopeSpec.scope === "agent") {
      const teamName = normalizePathSegment(scopeSpec.team_name, "team_name");
      if (!teamName) {
        throw new Error("agent scope 缺少 team_name");
      }
      const agentName = normalizePathSegment(scopeSpec.agent_name, "agent_name");
      if (!agentName) {
        throw new Error("agent scope 缺少 agent_name");
      }
      return resolveScopePath(memoryRoot, "teams", teamName, "agents", agentName);
    }
    if (scopeSpec.scope === "user") {
      const userId = normalizePathSegment(scopeSpec.user_id, "user_id");
      if (!userId) {
        throw new Error("user scope 缺少 user_id");
      }
      return resolveScopePath(memoryRoot, "users", userId);
    }
    const userId = normalizePathSegment(scopeSpec.user_id, "user_id");
    if (!userId) {
      throw new Error("workspace scope 缺少 user_id");
    }
    const workspaceKey = normalizePathSegment(scopeSpec.workspace_key, "workspace_key");
    if (!workspaceKey) {
      throw new Error("workspace scope 缺少 workspace_key");
    }
    const userWorkspaceRoot = resolveScopePath(memoryRoot, "users", userId, "workspaces", workspaceKey);
    migrateLegacyWorkspace(resolveScopePath(memoryRoot, "workspaces", workspaceKey), userWorkspaceRoot);
    return userWorkspaceRoot;
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
    } catch (error) {
      console.warn("[memory-store] loadIndexHead failed", { scope: scopeSpec.scope, error });
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
      const filePath = resolveEntryPath(scopeRoot, normalizedFileName);
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return {
        scope: scopeSpec.scope,
        file_name: normalizedFileName,
        file_path: filePath,
        content: fs.readFileSync(filePath, "utf8"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.warn("[memory-store] readEntryFile failed", {
        scope: scopeSpec.scope,
        fileName: normalizedFileName,
        error,
      });
      return null;
    }
  }

  saveMemory(rawInput: SaveMemoryInput): SavedMemoryFile {
    const input = SaveMemoryInputSchema.parse(rawInput);
    const scopeRoot = this.ensureScope(input);
    return withScopeLock(scopeRoot, () => this.saveMemoryUnlocked(input, scopeRoot));
  }

  saveMemoryWithCommit(rawInput: SaveMemoryInput, commit: (saved: SavedMemoryFile) => boolean): SavedMemoryFile {
    const input = SaveMemoryInputSchema.parse(rawInput);
    const scopeRoot = this.ensureScope(input);
    return withScopeLock(scopeRoot, () => {
      const fileName = memoryFileName(input);
      const snapshot = snapshotEntryFile(scopeRoot, fileName);
      let writtenContent = "";
      try {
        const saved = this.saveMemoryUnlocked(input, scopeRoot);
        writtenContent = fs.readFileSync(saved.file_path, "utf8");
        if (!commit(saved)) throw new Error("memory publish state changed before commit");
        return saved;
      } catch (error) {
        restoreEntryFile(scopeRoot, fileName, snapshot, writtenContent);
        this.rebuildIndexUnlocked(input, scopeRoot);
        throw error;
      }
    });
  }

  private saveMemoryUnlocked(input: SaveMemoryInput, scopeRoot: string): SavedMemoryFile {
    const normalizedMemoryType = normalizeString(input.memory_type)?.toLowerCase() ?? "fact";
    if (!ALLOWED_MEMORY_TYPES.has(normalizedMemoryType)) {
      throw new Error(`不支持的 memory_type: ${input.memory_type}`);
    }
    const fileName = memoryFileName(input);
    const filePath = resolveEntryPath(scopeRoot, fileName);
    const now = nowIso();
    const existing = fs.existsSync(filePath) ? readEntry(filePath) : null;
    const createdAt = existing?.created_at || now;
    const bodyLines = [input.content.trim()];
    const why = normalizeString(input.why);
    if (why) bodyLines.push("", `**Why:** ${why}`);
    const howToApply = normalizeString(input.how_to_apply);
    if (howToApply) bodyLines.push(`**How to apply:** ${howToApply}`);
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
    atomicWriteFile(filePath, renderMarkdown(frontmatter, `${bodyLines.join("\n").trim()}\n`));
    this.rebuildIndexUnlocked(input, scopeRoot);
    return { file_name: fileName, file_path: filePath, scope: input.scope };
  }

  listEntries(scopeSpec: MemoryScopeSpec, options: { includeArchived?: boolean | undefined } = {}): MemoryEntry[] {
    return readEntriesUnlocked(this.ensureScope(scopeSpec), options.includeArchived === true);
  }

  archiveMemory(scopeSpec: MemoryScopeSpec, fileName: string): boolean {
    const scopeRoot = this.ensureScope(scopeSpec);
    return withScopeLock(scopeRoot, () => this.archiveMemoryUnlocked(scopeSpec, scopeRoot, fileName));
  }

  archiveMemoryWithCommit(
    scopeSpec: MemoryScopeSpec,
    fileName: string,
    commit: () => boolean,
  ): boolean {
    const scopeRoot = this.ensureScope(scopeSpec);
    return withScopeLock(scopeRoot, () => {
      const normalizedFileName = path.basename(fileName);
      const snapshot = snapshotEntryFile(scopeRoot, normalizedFileName);
      let writtenContent = "";
      try {
        const archived = this.archiveMemoryUnlocked(scopeSpec, scopeRoot, fileName);
        if (!archived) return false;
        writtenContent = fs.readFileSync(resolveEntryPath(scopeRoot, normalizedFileName), "utf8");
        if (!commit()) throw new Error("memory archive state changed before commit");
        return true;
      } catch (error) {
        restoreEntryFile(scopeRoot, normalizedFileName, snapshot, writtenContent);
        this.rebuildIndexUnlocked(scopeSpec, scopeRoot);
        throw error;
      }
    });
  }

  private archiveMemoryUnlocked(scopeSpec: MemoryScopeSpec, scopeRoot: string, fileName: string): boolean {
    const normalizedFileName = path.basename(fileName);
    if (!normalizedFileName || normalizedFileName === "." || normalizedFileName === ".." || normalizedFileName !== fileName) {
      return false;
    }
    const filePath = resolveEntryPath(scopeRoot, normalizedFileName);
    const entry = readEntry(filePath);
    if (!entry) return false;
    const text = fs.readFileSync(filePath, "utf8");
    if (!text.includes("status: active")) return false;
    atomicWriteFile(filePath, text.replace("status: active", "status: archived"));
    this.rebuildIndexUnlocked(scopeSpec, scopeRoot);
    return true;
  }

  private rebuildIndexUnlocked(scopeSpec: MemoryScopeSpec, scopeRoot: string): void {
    const entries = readEntriesUnlocked(scopeRoot, false);
    const lines = [`# ${titleCase(scopeSpec.scope)} Memory`, ""];
    if (entries.length) {
      lines.push("## Index", "");
      for (const entry of entries) lines.push(`- [${entry.name}](${entry.file_name}) - ${entry.description}`);
    } else {
      lines.push("暂无记忆。");
    }
    atomicWriteFile(resolveEntryPath(scopeRoot, "MEMORY.md"), `${lines.join("\n").trim()}\n`);
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
    scope: asMemoryScopeName(metadata.type),
    memory_type: metadata.memory_type ?? "fact",
    status: metadata.status ?? "active",
    file_name: path.basename(filePath),
    file_path: filePath,
    created_at: metadata.created_at ?? "",
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

function memoryFileName(input: SaveMemoryInput): string {
  const memoryType = normalizeString(input.memory_type)?.toLowerCase() ?? "fact";
  return `${memoryType}_${slugify(input.name)}.md`;
}

function readEntriesUnlocked(scopeRoot: string, includeArchived: boolean): MemoryEntry[] {
  const entries = fs.readdirSync(scopeRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md")
    .map((entry) => {
      try {
        return readEntry(resolveEntryPath(scopeRoot, entry.name));
      } catch {
        return null;
      }
    })
    .filter((entry): entry is MemoryEntry => Boolean(entry))
    .filter((entry) => includeArchived || entry.status === "active");
  entries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return entries;
}

function withScopeLock<T>(scopeRoot: string, operation: () => T): T {
  try {
    return withLeaseLockSync(path.join(scopeRoot, ".memory-scope"), operation, {
      staleMs: 5 * 60_000,
      updateMs: 30_000,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOCKED" || code === "ECOMPROMISED") {
      throw Object.assign(new Error("memory entry busy"), { cause: error });
    }
    throw error;
  }
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

function normalizePathSegment(value: string | null | undefined, fieldName: string): string | null {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (
    normalized === "." || normalized === ".." || path.isAbsolute(normalized) ||
    normalized.includes("/") || normalized.includes("\\") || normalized.includes(":") ||
    path.basename(normalized) !== normalized
  ) {
    throw new Error(`${fieldName} 包含非法路径字符`);
  }
  return normalized;
}

function resolveScopePath(memoryRoot: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(memoryRoot);
  const dataRoot = path.dirname(resolvedRoot);
  const projectedDataRoot = fs.realpathSync(dataRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const projectedMemoryRoot = fs.realpathSync(resolvedRoot);
  if (!isPathWithin(projectedMemoryRoot, projectedDataRoot)) {
    throw new Error("memory 根目录通过符号链接越出租户 dataRoot");
  }
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isPathWithin(candidate, resolvedRoot)) {
    throw new Error("memory scope 路径越界");
  }
  const existingAncestor = nearestExistingAncestor(candidate);
  const projectedRoot = projectedMemoryRoot;
  const projectedAncestor = fs.realpathSync(existingAncestor);
  if (!isPathWithin(projectedAncestor, projectedRoot)) {
    throw new Error("memory scope 通过符号链接越界");
  }
  return candidate;
}

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("无法解析 memory scope 路径");
    current = parent;
  }
  return current;
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function migrateLegacyWorkspace(legacyRoot: string, userWorkspaceRoot: string): void {
  if (!fs.existsSync(legacyRoot) || fs.existsSync(path.join(userWorkspaceRoot, "MEMORY.md"))) return;
  fs.mkdirSync(path.dirname(userWorkspaceRoot), { recursive: true });
  fs.cpSync(legacyRoot, userWorkspaceRoot, { recursive: true, force: false, errorOnExist: false });
}

function snapshotEntryFile(scopeRoot: string, fileName: string): { exists: boolean; content?: string } {
  const filePath = resolveEntryPath(scopeRoot, fileName);
  return fs.existsSync(filePath)
    ? { exists: true, content: fs.readFileSync(filePath, "utf8") }
    : { exists: false };
}

function restoreEntryFile(scopeRoot: string, fileName: string, snapshot: { exists: boolean; content?: string }, expectedContent: string): void {
  const filePath = resolveEntryPath(scopeRoot, fileName);
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") !== expectedContent) return;
  if (snapshot.exists) {
    atomicWriteFile(filePath, snapshot.content ?? "");
  } else if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
}

function atomicWriteFile(filePath: string, content: string): void {
  const tempPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}

function resolveEntryPath(scopeRoot: string, fileName: string): string {
  const normalized = path.basename(fileName);
  if (!normalized || normalized === "." || normalized === ".." || normalized !== fileName || !normalized.endsWith(".md")) {
    throw new Error(`非法 memory 文件名: ${fileName}`);
  }
  const filePath = path.resolve(scopeRoot, normalized);
  const projectedRoot = fs.realpathSync(scopeRoot);
  if (!isPathWithin(filePath, path.resolve(scopeRoot))) throw new Error("memory 文件路径越界");
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error("memory 条目不允许使用符号链接");
    if (!isPathWithin(fs.realpathSync(filePath), projectedRoot)) {
      throw new Error("memory 文件通过符号链接越界");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return filePath;
}

function asMemoryScopeName(value: string | undefined): MemoryScopeName {
  return value === "team" || value === "agent" || value === "workspace" || value === "user" ? value : "session";
}

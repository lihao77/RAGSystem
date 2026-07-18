import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PersistedMemoryEntry } from "../../contracts/memory-store/index.js";
import { createTenantId } from "../../identity/types.js";
import { toMemoryScopePartition } from "../memory/scope-partition.js";
import type { MemoryScopePartition } from "../memory/index.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const VALID_MEMORY_TYPES = new Set(["preference", "constraint", "goal", "fact", "profile"]);

export interface FilesystemMemoryImportEntry extends PersistedMemoryEntry {
  source_relative_path: string;
  semantic_checksum: string;
}

export interface FilesystemMemoryImportIssue {
  source_relative_path: string;
  message: string;
}

export interface FilesystemMemoryScanResult {
  source_data_root: string;
  memory_root_found: boolean;
  tenant_id: string;
  entries: FilesystemMemoryImportEntry[];
  issues: FilesystemMemoryImportIssue[];
  semantic_checksum: string;
  excluded: {
    derived_indexes: number;
    sqlite_candidates: true;
    legacy_workspaces: number;
  };
}

interface ScopeDirectory {
  directory: string;
  partition: MemoryScopePartition;
}

/** Reads canonical Local Memory markdown from an explicitly selected dataRoot. */
export function scanFilesystemMemory(
  sourceDataRoot: string,
  rawTenantId: string,
): FilesystemMemoryScanResult {
  const sourceRoot = path.resolve(requireNonEmpty(sourceDataRoot, "source dataRoot"));
  const tenantId = createTenantId(rawTenantId);
  const memoryRoot = path.join(sourceRoot, "memory");
  if (!fs.existsSync(memoryRoot)) {
    return emptyResult(sourceRoot, tenantId);
  }
  const memoryStat = fs.lstatSync(memoryRoot);
  if (!memoryStat.isDirectory() || memoryStat.isSymbolicLink()) {
    throw new Error(`Local Memory root must be a real directory: ${memoryRoot}`);
  }

  const entries: FilesystemMemoryImportEntry[] = [];
  const issues: FilesystemMemoryImportIssue[] = [];
  let derivedIndexes = 0;
  const scopes = discoverScopeDirectories(memoryRoot);
  for (const scope of scopes.directories) {
    for (const dirent of fs.readdirSync(scope.directory, { withFileTypes: true })) {
      if (dirent.name === "MEMORY.md") {
        derivedIndexes += 1;
        continue;
      }
      if (!dirent.isFile() || dirent.isSymbolicLink() || !dirent.name.endsWith(".md")) continue;
      const filePath = path.join(scope.directory, dirent.name);
      const relativePath = normalizeRelativePath(path.relative(memoryRoot, filePath));
      try {
        entries.push(parseEntry(filePath, relativePath, tenantId, scope.partition));
      } catch (error) {
        issues.push({
          source_relative_path: relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  entries.sort((left, right) => left.source_relative_path.localeCompare(right.source_relative_path));
  issues.sort((left, right) => left.source_relative_path.localeCompare(right.source_relative_path));
  return {
    source_data_root: sourceRoot,
    memory_root_found: true,
    tenant_id: tenantId,
    entries,
    issues,
    semantic_checksum: checksum(entries.map(({ semantic_checksum }) => semantic_checksum)),
    excluded: {
      derived_indexes: derivedIndexes,
      sqlite_candidates: true,
      legacy_workspaces: scopes.legacyWorkspaces,
    },
  };
}

function emptyResult(sourceRoot: string, tenantId: string): FilesystemMemoryScanResult {
  return {
    source_data_root: sourceRoot,
    memory_root_found: false,
    tenant_id: tenantId,
    entries: [],
    issues: [],
    semantic_checksum: checksum([]),
    excluded: { derived_indexes: 0, sqlite_candidates: true, legacy_workspaces: 0 },
  };
}

function discoverScopeDirectories(memoryRoot: string): {
  directories: ScopeDirectory[];
  legacyWorkspaces: number;
} {
  const output: ScopeDirectory[] = [];
  const teamsRoot = path.join(memoryRoot, "teams");
  for (const teamName of childDirectoryNames(teamsRoot)) {
    const teamRoot = path.join(teamsRoot, teamName);
    output.push(scopeDirectory(teamRoot, { scope: "team", team_name: teamName }));
    const agentsRoot = path.join(teamRoot, "agents");
    for (const agentName of childDirectoryNames(agentsRoot)) {
      output.push(scopeDirectory(path.join(agentsRoot, agentName), {
        scope: "agent",
        team_name: teamName,
        agent_name: agentName,
      }));
    }
  }

  const sessionsRoot = path.join(memoryRoot, "sessions");
  for (const sessionId of childDirectoryNames(sessionsRoot)) {
    output.push(scopeDirectory(path.join(sessionsRoot, sessionId), { scope: "session", session_id: sessionId }));
  }

  const usersRoot = path.join(memoryRoot, "users");
  for (const userId of childDirectoryNames(usersRoot)) {
    const userRoot = path.join(usersRoot, userId);
    output.push(scopeDirectory(userRoot, { scope: "user", user_id: userId }));
    const workspacesRoot = path.join(userRoot, "workspaces");
    for (const workspaceKey of childDirectoryNames(workspacesRoot)) {
      output.push(scopeDirectory(path.join(workspacesRoot, workspaceKey), {
        scope: "workspace",
        user_id: userId,
        workspace_key: workspaceKey,
      }));
    }
  }

  return {
    directories: output,
    // Legacy memory/workspaces lacks a user dimension and cannot be imported safely.
    legacyWorkspaces: childDirectoryNames(path.join(memoryRoot, "workspaces")).length,
  };
}

function scopeDirectory(
  directory: string,
  scopeSpec: Parameters<typeof toMemoryScopePartition>[0],
): ScopeDirectory {
  const partition = toMemoryScopePartition(scopeSpec);
  if (!partition) throw new Error(`Invalid Local Memory scope: ${directory}`);
  return { directory, partition };
}

function childDirectoryNames(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function parseEntry(
  filePath: string,
  relativePath: string,
  tenantId: string,
  partition: MemoryScopePartition,
): FilesystemMemoryImportEntry {
  const text = fs.readFileSync(filePath, "utf8");
  const match = FRONTMATTER_RE.exec(text);
  if (!match) throw new Error("Invalid Memory markdown frontmatter");
  const metadata = parseFrontmatter(match[1] ?? "");
  const metadataScope = metadata.type?.trim();
  if (metadataScope && metadataScope !== partition.scope) {
    throw new Error(`Scope mismatch: path=${partition.scope}, frontmatter=${metadataScope}`);
  }
  const memoryType = (metadata.memory_type?.trim().toLowerCase() || "fact");
  if (!VALID_MEMORY_TYPES.has(memoryType)) throw new Error(`Unsupported memory_type: ${memoryType}`);
  const status = metadata.status?.trim().toLowerCase() || "active";
  if (status !== "active" && status !== "archived") throw new Error(`Unsupported memory status: ${status}`);
  const stat = fs.statSync(filePath);
  const createdAt = parseTimestamp(metadata.created_at, stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime, "created_at");
  const updatedAt = parseTimestamp(metadata.updated_at, stat.mtime, "updated_at");
  const body = splitGeneratedSections((match[2] ?? "").trim());
  const id = `localfs_${checksum([tenantId, partition.scope, partition.scope_id, relativePath]).slice(0, 40)}`;
  const canonical = {
    tenant_id: tenantId,
    id,
    ...partition,
    name: metadata.name?.trim() || path.basename(filePath, path.extname(filePath)),
    description: metadata.description?.trim() || "",
    memory_type: memoryType,
    content: body.content,
    why: body.why,
    how_to_apply: body.howToApply,
    status,
    source_run_id: normalizeOptional(metadata.source_run_id),
    source_message_id: normalizeOptional(metadata.source_message_id),
    version: 1,
    created_at: createdAt,
    updated_at: updatedAt,
    archived_at: status === "archived" ? updatedAt : null,
  } satisfies PersistedMemoryEntry;
  return {
    ...canonical,
    source_relative_path: relativePath,
    semantic_checksum: checksum(canonical),
  };
}

function parseFrontmatter(value: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return metadata;
}

function splitGeneratedSections(body: string): {
  content: string;
  why: string | null;
  howToApply: string | null;
} {
  let content = body;
  let howToApply: string | null = null;
  const howMatch = /(?:^|\n)\*\*How to apply:\*\*\s*([\s\S]*)$/i.exec(content);
  if (howMatch?.index != null) {
    howToApply = normalizeOptional(howMatch[1]);
    content = content.slice(0, howMatch.index).trim();
  }
  let why: string | null = null;
  const whyMatch = /(?:^|\n)\*\*Why:\*\*\s*([\s\S]*)$/i.exec(content);
  if (whyMatch?.index != null) {
    why = normalizeOptional(whyMatch[1]);
    content = content.slice(0, whyMatch.index).trim();
  }
  return { content, why, howToApply };
}

function parseTimestamp(value: string | undefined, fallback: Date, field: string): string {
  if (!value?.trim()) return fallback.toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${field}: ${value}`);
  return new Date(timestamp).toISOString();
}

function normalizeOptional(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireNonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must not be empty`);
  return value;
}

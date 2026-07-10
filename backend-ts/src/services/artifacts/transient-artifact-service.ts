import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withArtifactIndexLock } from "@ragsystem/agent-sdk";

const ORPHAN_GRACE_SECONDS = 24 * 60 * 60;
const MANAGED_ARTIFACT_NAME = /^(?:data_[a-f0-9]{8}\.(?:txt|json)|image_[a-f0-9]{8}\.(?:png|jpg|gif|webp))$/;
const TEMP_INDEX_NAME = /^artifact_index\.[a-f0-9-]+\.tmp$/;

interface TransientArtifactRecord {
  path: string;
  expires_at?: number;
  [key: string]: unknown;
}

export interface TransientPruneResult {
  deleted: number;
  retained: number;
}

/** Owns lifecycle cleanup for SDK observation artifacts under sessions/<id>/transient. */
export class TransientArtifactService {
  private readonly sessionsRoot: string;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataRoot: string) {
    this.sessionsRoot = path.join(path.resolve(dataRoot), "sessions");
  }

  startPruning(intervalMs = 60 * 60 * 1000): void {
    if (this.pruneTimer) return;
    void this.pruneExpired().catch(() => undefined);
    this.pruneTimer = setInterval(() => {
      void this.pruneExpired().catch(() => undefined);
    }, intervalMs);
    this.pruneTimer.unref?.();
  }

  stopPruning(): void {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  async pruneExpired(nowSeconds = Date.now() / 1000): Promise<TransientPruneResult> {
    let deleted = 0;
    let retained = 0;
    for (const sessionId of await this.listSessionIds()) {
      const result = await this.pruneSession(sessionId, nowSeconds);
      deleted += result.deleted;
      retained += result.retained;
    }
    return { deleted, retained };
  }

  deleteSessionArtifacts(sessionId: string): void {
    if (!isSafeSessionId(sessionId)) return;
    fs.rmSync(path.join(this.sessionsRoot, sessionId), { recursive: true, force: true });
  }

  private async pruneSession(sessionId: string, nowSeconds: number): Promise<TransientPruneResult> {
    const transientRoot = path.join(this.sessionsRoot, sessionId, "transient");
    try {
      await fs.promises.access(transientRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted: 0, retained: 0 };
      throw error;
    }
    const result = await withArtifactIndexLock(transientRoot, async () => this.pruneSessionLocked(transientRoot, nowSeconds));
    await removeDirectoryIfEmpty(transientRoot);
    return result;
  }

  private async pruneSessionLocked(transientRoot: string, nowSeconds: number): Promise<TransientPruneResult> {
    const indexPath = path.join(transientRoot, "artifact_index.jsonl");
    let raw: string;
    try {
      raw = await fs.promises.readFile(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { deleted: await removeOrphanedFiles(transientRoot, new Set(), nowSeconds), retained: 0 };
      }
      throw error;
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const retainedLines: string[] = [];
    const retainedPaths = new Set<string>();
    let deleted = 0;
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record || typeof record.expires_at !== "number" || record.expires_at > nowSeconds) {
        retainedLines.push(line);
        if (record) retainedPaths.add(path.resolve(record.path));
        continue;
      }
      const filePath = path.resolve(record.path);
      if (!isPathUnder(filePath, transientRoot)) {
        retainedLines.push(line);
        continue;
      }
      await fs.promises.rm(filePath, { force: true });
      deleted += 1;
    }

    if (retainedLines.length > 0) {
      await writeIndexAtomically(indexPath, `${retainedLines.join("\n")}\n`);
    } else {
      await fs.promises.rm(indexPath, { force: true });
    }
    deleted += await removeOrphanedFiles(transientRoot, retainedPaths, nowSeconds);
    return { deleted, retained: retainedLines.length };
  }

  private async listSessionIds(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.sessionsRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && isSafeSessionId(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

async function writeIndexAtomically(indexPath: string, content: string): Promise<void> {
  const tempPath = path.join(path.dirname(indexPath), `artifact_index.${randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, indexPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function removeOrphanedFiles(root: string, indexedPaths: Set<string>, nowSeconds: number): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || (!MANAGED_ARTIFACT_NAME.test(entry.name) && !TEMP_INDEX_NAME.test(entry.name))) continue;
    const filePath = path.resolve(root, entry.name);
    if (indexedPaths.has(filePath)) continue;
    const stat = await fs.promises.stat(filePath);
    if (stat.mtimeMs / 1000 + ORPHAN_GRACE_SECONDS > nowSeconds) continue;
    await fs.promises.rm(filePath, { force: true });
    deleted += 1;
  }
  return deleted;
}

function parseRecord(line: string): TransientArtifactRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.path === "string" ? (record as TransientArtifactRecord) : null;
  } catch {
    return null;
  }
}

function isSafeSessionId(sessionId: string): boolean {
  return Boolean(sessionId) && sessionId !== "." && sessionId !== ".." && !sessionId.includes("/") && !sessionId.includes("\\");
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    if ((await fs.promises.readdir(directory)).length === 0) await fs.promises.rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

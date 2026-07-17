import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface MemoryFileSnapshot {
  exists: boolean;
  content?: string;
}

export async function ensureIndexFile(indexPath: string, defaultContent: string): Promise<void> {
  try {
    await fs.promises.writeFile(indexPath, defaultContent, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function snapshotFile(filePath: string): Promise<MemoryFileSnapshot> {
  try {
    return { exists: true, content: await fs.promises.readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

export async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Restore only if the file still contains this mutation's expected content. */
export async function restoreFileIfExpected(
  filePath: string,
  snapshot: MemoryFileSnapshot,
  expectedContent: string | undefined,
): Promise<void> {
  const current = await readFileIfExists(filePath);
  if (expectedContent !== undefined && current !== expectedContent) return;
  if (snapshot.exists) {
    await atomicWriteFile(filePath, snapshot.content ?? "");
  } else if (current !== null) {
    await fs.promises.rm(filePath, { force: true });
  }
}

export async function migrateLegacyWorkspace(legacyRoot: string, userWorkspaceRoot: string): Promise<void> {
  if (!(await exists(legacyRoot)) || await exists(path.join(userWorkspaceRoot, "MEMORY.md"))) return;
  await fs.promises.mkdir(path.dirname(userWorkspaceRoot), { recursive: true });
  await fs.promises.cp(legacyRoot, userWorkspaceRoot, { recursive: true, force: false, errorOnExist: false });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

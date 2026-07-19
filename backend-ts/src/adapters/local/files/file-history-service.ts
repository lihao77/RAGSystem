import { isRecord } from "../../../utils/guards.js";
import fs from "node:fs";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";

import type {
  FileHistoryRewindResult,
  FileHistorySnapshot,
  FileHistoryStoreOptions,
  FileHistoryTrackedFile,
  IFileHistoryStore,
} from "../../../contracts/file-history-store/index.js";

export class FileHistoryService implements IFileHistoryStore {
  private readonly dataRoot: string;
  private readonly trackedBySession = new Map<string, Map<string, FileHistoryTrackedFile>>();

  constructor(options: FileHistoryStoreOptions = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("FileHistoryService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
  }

  trackEdit(sessionId: string | null | undefined, filePath: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const resolvedPath = path.resolve(filePath);
    const tracked = this.getTracked(normalizedSessionId);
    if (tracked.has(resolvedPath)) {
      return;
    }
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      tracked.set(resolvedPath, {
        backup_hash: this.backupFile(normalizedSessionId, resolvedPath),
        action: "modified",
      });
      this.savePending(normalizedSessionId, tracked);
      return;
    }
    tracked.set(resolvedPath, {
      backup_hash: null,
      action: "created",
    });
    this.savePending(normalizedSessionId, tracked);
  }

  makeSnapshot(sessionId: string | null | undefined, messageSeq: number): string | null {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !Number.isInteger(messageSeq)) {
      return null;
    }
    const tracked = this.getTracked(normalizedSessionId);
    if (!tracked?.size) {
      return null;
    }
    const snapshotId = randomUUID().replace(/-/g, "").slice(0, 16);
    const snapshot: FileHistorySnapshot = {
      snapshot_id: snapshotId,
      message_seq: messageSeq,
      tracked_files: Object.fromEntries(tracked.entries()),
      created_at: new Date().toISOString(),
    };
    const snapshots = this.loadSnapshots(normalizedSessionId);
    snapshots.push(snapshot);
    this.saveSnapshots(normalizedSessionId, snapshots);
    tracked.clear();
    this.clearPending(normalizedSessionId);
    return snapshotId;
  }

  getPendingTracked(sessionId: string | null | undefined): Record<string, FileHistoryTrackedFile> | null {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return null;
    const tracked = this.getTracked(normalizedSessionId);
    if (!tracked?.size) return null;
    return Object.fromEntries(tracked.entries());
  }

  rewind(sessionId: string | null | undefined, targetSeq: number): FileHistoryRewindResult {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !Number.isInteger(targetSeq)) {
      return { success: false, message: "无效的 session_id 或 target_seq", reverted_files: 0 };
    }
    const snapshots = this.loadSnapshots(normalizedSessionId);
    const pending = new Map(this.getTracked(normalizedSessionId).entries());
    if (!snapshots.length && !pending.size) {
      return { success: true, message: "无可回退的文件快照（该会话无编辑历史）", reverted_files: 0 };
    }

    const toRevert = snapshots
      .filter((snapshot) => snapshot.message_seq > targetSeq)
      .sort((left, right) => left.message_seq - right.message_seq);
    const restoreMap = new Map<string, string | null>();
    for (const snapshot of toRevert) {
      for (const [filePath, info] of Object.entries(snapshot.tracked_files)) {
        if (!restoreMap.has(filePath)) {
          restoreMap.set(filePath, info.backup_hash ?? null);
        }
      }
    }
    for (const [filePath, info] of pending.entries()) {
      if (!restoreMap.has(filePath)) {
        restoreMap.set(filePath, info.backup_hash ?? null);
      }
    }

    if (!restoreMap.size) {
      return { success: true, message: "无需回退", reverted_files: 0 };
    }
    for (const [filePath, backupHash] of restoreMap.entries()) {
      this.restoreFile(normalizedSessionId, filePath, backupHash);
    }
    this.saveSnapshots(normalizedSessionId, snapshots.filter((snapshot) => snapshot.message_seq <= targetSeq));
    this.getTracked(normalizedSessionId).clear();
    this.clearPending(normalizedSessionId);
    return {
      success: true,
      message: `已回退到 seq=${targetSeq}，恢复了 ${restoreMap.size} 个文件`,
      reverted_files: restoreMap.size,
    };
  }

  hasSnapshots(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }
    return this.loadSnapshots(normalizedSessionId).length > 0 || this.getTracked(normalizedSessionId).size > 0;
  }

  listSnapshots(sessionId: string | null | undefined): FileHistorySnapshot[] {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return normalizedSessionId ? this.loadSnapshots(normalizedSessionId) : [];
  }

  readBackup(sessionId: string | null | undefined, backupHash: string | null | undefined): string | null {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedHash = backupHash?.trim();
    if (!normalizedSessionId || !normalizedHash || !/^[a-f0-9]{64}$/i.test(normalizedHash)) {
      return null;
    }
    const backupPath = path.join(this.backupsRoot(normalizedSessionId), normalizedHash);
    return fs.existsSync(backupPath) ? fs.readFileSync(backupPath, "utf8") : null;
  }

  cleanup(sessionId: string | null | undefined): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    this.trackedBySession.delete(normalizedSessionId);
    const root = this.sessionRoot(normalizedSessionId);
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  private getTracked(sessionId: string): Map<string, FileHistoryTrackedFile> {
    const existing = this.trackedBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const tracked = new Map(Object.entries(this.loadPending(sessionId)));
    this.trackedBySession.set(sessionId, tracked);
    return tracked;
  }

  private loadPending(sessionId: string): Record<string, FileHistoryTrackedFile> {
    const pendingPath = this.pendingPath(sessionId);
    if (!fs.existsSync(pendingPath)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
      return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter(isTrackedFileEntry)) : {};
    } catch {
      return {};
    }
  }

  private savePending(sessionId: string, entries: Map<string, FileHistoryTrackedFile>): void {
    const pendingPath = this.pendingPath(sessionId);
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, "utf8");
  }

  private clearPending(sessionId: string): void {
    const pendingPath = this.pendingPath(sessionId);
    if (fs.existsSync(pendingPath)) fs.rmSync(pendingPath, { force: true });
  }

  private backupFile(sessionId: string, filePath: string): string {
    const data = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    const backupPath = path.join(this.backupsRoot(sessionId), hash);
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, data);
    }
    return hash;
  }

  private restoreFile(sessionId: string, filePath: string, backupHash: string | null): void {
    if (!backupHash) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
      return;
    }
    // 防穿越：backupHash 必须是合法 sha256（与 readBackup 一致校验），绝不直接拼未经校验的路径片段
    if (!/^[a-f0-9]{64}$/i.test(backupHash)) {
      return;
    }
    const backupPath = path.join(this.backupsRoot(sessionId), backupHash);
    if (!fs.existsSync(backupPath)) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(backupPath, filePath);
  }

  private loadSnapshots(sessionId: string): FileHistorySnapshot[] {
    const snapshotsPath = this.snapshotsPath(sessionId);
    if (!fs.existsSync(snapshotsPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(snapshotsPath, "utf8"));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isSnapshot);
    } catch {
      return [];
    }
  }

  private saveSnapshots(sessionId: string, snapshots: FileHistorySnapshot[]): void {
    const snapshotsPath = this.snapshotsPath(sessionId);
    fs.mkdirSync(path.dirname(snapshotsPath), { recursive: true });
    fs.writeFileSync(snapshotsPath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
  }

  private sessionRoot(sessionId: string): string {
    return path.join(this.dataRoot, "file-history", safeSessionDirName(sessionId));
  }

  private backupsRoot(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), "backups");
  }

  private snapshotsPath(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), "snapshots.json");
  }

  private pendingPath(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), "pending.json");
  }
}

function normalizeSessionId(sessionId: string | null | undefined): string | null {
  const normalized = sessionId?.trim();
  return normalized || null;
}

function safeSessionDirName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "session";
}

function isSnapshot(value: unknown): value is FileHistorySnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.snapshot_id === "string" &&
    typeof value.message_seq === "number" &&
    Number.isInteger(value.message_seq) &&
    isRecord(value.tracked_files) &&
    typeof value.created_at === "string"
  );
}



function isTrackedFileEntry(entry: [string, unknown]): entry is [string, FileHistoryTrackedFile] {
  const [, value] = entry;
  if (!isRecord(value)) {
    return false;
  }
  // modified 必须带合法 sha256 备份；created 必须无备份。拒掉 pending.json 篡改/损坏注入的非法 hash
  if (value.action === "modified") {
    return typeof value.backup_hash === "string" && /^[a-f0-9]{64}$/i.test(value.backup_hash);
  }
  if (value.action === "created") {
    return value.backup_hash === null;
  }
  return false;
}

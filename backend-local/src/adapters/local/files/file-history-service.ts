import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import fs from "node:fs";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";

import type {
  FileHistoryRewindResult,
  FileHistorySnapshot,
  FileHistoryTrackedFile,
} from "@ragsystem/backend-core/contracts/file-history-store/index.js";

export interface FileHistoryStoreOptions {
  dataRoot?: string | undefined;
  /** 追踪时刻取会话当前最大消息 seq（回退门控用）；缺省时 tracked_seq 记 null，rewind 不冲刷该条。 */
  maxSeqProvider?: ((sessionId: string) => number | null) | undefined;
}

export class FileHistoryService {
  private readonly dataRoot: string;
  private readonly trackedBySession = new Map<string, Map<string, FileHistoryTrackedFile>>();

  constructor(options: FileHistoryStoreOptions = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("FileHistoryService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
    this.maxSeqProvider = options.maxSeqProvider ?? null;
  }

  private readonly maxSeqProvider: ((sessionId: string) => number | null) | null;

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
    const trackedSeq = this.maxSeqProvider?.(normalizedSessionId) ?? null;
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      tracked.set(resolvedPath, {
        backup_hash: this.backupFile(normalizedSessionId, resolvedPath),
        action: "modified",
        tracked_seq: trackedSeq,
      });
      this.savePending(normalizedSessionId, tracked);
      return;
    }
    tracked.set(resolvedPath, {
      backup_hash: null,
      action: "created",
      tracked_seq: trackedSeq,
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
    const tracked = this.getTracked(normalizedSessionId);
    if (!snapshots.length && !tracked.size) {
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
    // pending 门控：只有 tracked_seq >= targetSeq（编辑发生在锚点消息落库之后）的条目才属于本次
    // 回退要撤销的范围；锚点之前遗留的编辑（典型：被停止 run 的工作，尚未走到快照边界）必须原样
    // 留在 pending 等下一个边界归档。无 tracked_seq 的历史存量条目同样只保留不冲刷——宁可漏回退
    // （文件可见、可手修）不可错回退（静默毁掉无关工作）。
    const keptPending = new Map<string, FileHistoryTrackedFile>();
    for (const [filePath, info] of tracked.entries()) {
      if (restoreMap.has(filePath)) continue;
      if (info.tracked_seq != null && info.tracked_seq >= targetSeq) {
        restoreMap.set(filePath, info.backup_hash ?? null);
      } else {
        keptPending.set(filePath, info);
      }
    }

    if (!restoreMap.size) {
      return { success: true, message: "无需回退", reverted_files: 0 };
    }
    for (const [filePath, backupHash] of restoreMap.entries()) {
      this.restoreFile(normalizedSessionId, filePath, backupHash);
    }
    this.saveSnapshots(normalizedSessionId, snapshots.filter((snapshot) => snapshot.message_seq <= targetSeq));
    tracked.clear();
    for (const [filePath, info] of keptPending.entries()) {
      tracked.set(filePath, info);
    }
    if (keptPending.size > 0) {
      this.savePending(normalizedSessionId, tracked);
    } else {
      this.clearPending(normalizedSessionId);
    }
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
    if (!(typeof value.backup_hash === "string" && /^[a-f0-9]{64}$/i.test(value.backup_hash))) return false;
  } else if (value.action !== "created" || value.backup_hash !== null) {
    return false;
  }
  // tracked_seq 可缺省（历史存量，rewind 门控会跳过）；在场则必须是非负有限整数，防篡改注入。
  return value.tracked_seq === undefined
    || value.tracked_seq === null
    || (typeof value.tracked_seq === "number" && Number.isInteger(value.tracked_seq) && value.tracked_seq >= 0);
}

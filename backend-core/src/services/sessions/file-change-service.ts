import { diffLines } from "diff";

import type {
  FileChangeItem,
  FileChangeLine,
  LatestFileChanges,
} from "../../contracts/application/file-change-application.js";
import type { FileChangeHistoryPort, FileHistorySnapshot, FileHistoryTrackedFile } from "../../contracts/file-history-store/index.js";

export type { FileChangeItem, FileChangeLine, LatestFileChanges } from "../../contracts/application/file-change-application.js";

export class FileChangeService {
  constructor(private readonly fileHistory: FileChangeHistoryPort) {}

  async getLatest(sessionId: string, messageSeq?: number): Promise<LatestFileChanges> {
    const [snapshots, pending] = await Promise.all([
      this.fileHistory.listSnapshots(sessionId),
      this.fileHistory.getPendingTracked(sessionId),
    ]);
    const snapshot = messageSeq === undefined
      ? latestSnapshot(snapshots)
      : snapshotForMessage(snapshots, messageSeq);

    // A selected run must never fall back to another run's latest snapshot.
    // This is also the empty state for a run that did not modify any files.
    if (messageSeq !== undefined && !snapshot) {
      return { snapshot_id: null, message_seq: null, files: [] };
    }

    if (messageSeq !== undefined && snapshot) {
      const files = await buildSnapshotFiles(sessionId, snapshot, snapshots, pending, this.fileHistory);
      return {
        snapshot_id: snapshot.snapshot_id,
        message_seq: snapshot.message_seq,
        files,
      };
    }

    const trackedFiles = { ...(snapshot?.tracked_files ?? {}), ...(pending ?? {}) };
    if (!Object.keys(trackedFiles).length) {
      return { snapshot_id: null, message_seq: null, files: [] };
    }

    const files = await Promise.all(Object.entries(trackedFiles).map(async ([filePath, tracked]) => {
      const oldBytes = tracked.action === "modified" && tracked.backup_hash
        ? await this.fileHistory.readBackup(sessionId, tracked.backup_hash)
        : null;
      const currentBytes = await this.fileHistory.readCurrent(filePath);
      const oldContent = decode(oldBytes);
      const newContent = decode(currentBytes);
      const item: FileChangeItem = {
        path: filePath,
        action: tracked.action,
        newContent,
        diff: buildLineDiff(oldContent, newContent),
      };
      if (tracked.action === "modified") {
        item.oldContent = oldContent;
      }
      return item;
    }));

    return {
      snapshot_id: snapshot?.snapshot_id ?? null,
      message_seq: snapshot?.message_seq ?? null,
      files,
    };
  }
}

async function buildSnapshotFiles(
  sessionId: string,
  snapshot: FileHistorySnapshot,
  snapshots: FileHistorySnapshot[],
  pending: Record<string, FileHistoryTrackedFile> | null,
  fileHistory: FileChangeHistoryPort,
): Promise<FileChangeItem[]> {
  const laterSnapshots = snapshots
    .filter((candidate) => isAfterSnapshot(candidate, snapshot))
    .sort(compareSnapshots);

  return Promise.all(Object.entries(snapshot.tracked_files).map(async ([filePath, tracked]) => {
    const oldBytes = tracked.action === "modified" && tracked.backup_hash
      ? await fileHistory.readBackup(sessionId, tracked.backup_hash)
      : null;

    // A later snapshot's backup is the file state at the end of this run. It
    // prevents a historical run from being diffed against today's workspace.
    const laterTracked = laterSnapshots
      .map((candidate) => candidate.tracked_files[filePath])
      .find((candidate) => candidate !== undefined)
      ?? pending?.[filePath];
    const currentBytes = laterTracked
      ? await readTrackedContent(sessionId, laterTracked, fileHistory)
      : await fileHistory.readCurrent(filePath);
    const oldContent = decode(oldBytes);
    const newContent = decode(currentBytes);
    const item: FileChangeItem = {
      path: filePath,
      action: tracked.action,
      newContent,
      diff: buildLineDiff(oldContent, newContent),
    };
    if (tracked.action === "modified") item.oldContent = oldContent;
    return item;
  }));
}

async function readTrackedContent(
  sessionId: string,
  tracked: FileHistoryTrackedFile,
  fileHistory: FileChangeHistoryPort,
): Promise<Uint8Array | null> {
  if (tracked.action === "created" || !tracked.backup_hash) return null;
  return fileHistory.readBackup(sessionId, tracked.backup_hash);
}

function latestSnapshot(snapshots: FileHistorySnapshot[]): FileHistorySnapshot | null {
  return snapshots.reduce<FileHistorySnapshot | null>((latest, snapshot) => {
    if (!latest || snapshot.message_seq > latest.message_seq) {
      return snapshot;
    }
    if (snapshot.message_seq === latest.message_seq && snapshot.created_at > latest.created_at) {
      return snapshot;
    }
    return latest;
  }, null);
}

function snapshotForMessage(snapshots: FileHistorySnapshot[], messageSeq: number): FileHistorySnapshot | null {
  return latestSnapshot(snapshots.filter((snapshot) => snapshot.message_seq === messageSeq));
}

function compareSnapshots(left: FileHistorySnapshot, right: FileHistorySnapshot): number {
  return left.message_seq - right.message_seq || left.created_at.localeCompare(right.created_at);
}

function isAfterSnapshot(candidate: FileHistorySnapshot, snapshot: FileHistorySnapshot): boolean {
  return compareSnapshots(candidate, snapshot) > 0;
}

function buildLineDiff(oldContent: string, newContent: string): FileChangeLine[] {
  let oldLine = 1;
  let newLine = 1;
  const lines: FileChangeLine[] = [];
  for (const part of diffLines(oldContent, newContent)) {
    const type = part.added ? "added" : part.removed ? "removed" : "context";
    const contentLines = part.value.split("\n");
    if (contentLines.at(-1) === "") {
      contentLines.pop();
    }
    for (const content of contentLines) {
      // 只显示改动行（added/removed），跳过 context（全文不变行）——避免 diff 像全文
      if (type === "context") {
        oldLine += 1;
        newLine += 1;
        continue;
      }
      lines.push({
        type,
        content,
        oldLine: type === "added" ? null : oldLine++,
        newLine: type === "removed" ? null : newLine++,
      });
    }
  }
  return lines;
}

function decode(value: Uint8Array | null): string {
  return value ? new TextDecoder().decode(value) : "";
}

import fs from "node:fs";
import { diffLines } from "diff";

import type {
  FileChangeItem,
  FileChangeLine,
  LatestFileChanges,
} from "../../contracts/application/file-change-application.js";
import type { AsyncFileHistoryStore, FileHistorySnapshot, IFileHistoryStore } from "../../contracts/file-history-store/index.js";

export type { FileChangeItem, FileChangeLine, LatestFileChanges } from "../../contracts/application/file-change-application.js";

export class FileChangeService {
  constructor(private readonly fileHistory: IFileHistoryStore) {}

  getLatest(sessionId: string): LatestFileChanges {
    const snapshot = latestSnapshot(this.fileHistory.listSnapshots(sessionId));
    const pending = this.fileHistory.getPendingTracked(sessionId);
    const trackedFiles = { ...(snapshot?.tracked_files ?? {}), ...(pending ?? {}) };
    if (!Object.keys(trackedFiles).length) {
      return { snapshot_id: null, message_seq: null, files: [] };
    }

    const files = Object.entries(trackedFiles).map(([filePath, tracked]) => {
      const oldContent = tracked.action === "modified"
        ? this.fileHistory.readBackup(sessionId, tracked.backup_hash) ?? ""
        : "";
      const newContent = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? fs.readFileSync(filePath, "utf8")
        : "";
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
    });

    return {
      snapshot_id: snapshot?.snapshot_id ?? null,
      message_seq: snapshot?.message_seq ?? null,
      files,
    };
  }
}

export class AsyncFileChangeService {
  constructor(private readonly fileHistory: AsyncFileHistoryStore) {}

  async getLatest(sessionId: string): Promise<LatestFileChanges> {
    const [snapshots, pending] = await Promise.all([
      this.fileHistory.listSnapshots(sessionId),
      this.fileHistory.getPendingTracked(sessionId),
    ]);
    const snapshot = latestSnapshot(snapshots);
    const trackedFiles = { ...(snapshot?.tracked_files ?? {}), ...(pending ?? {}) };
    const files = await Promise.all(Object.entries(trackedFiles).map(async ([fileKey, tracked]) => {
      const oldBytes = tracked.action === "modified" && tracked.backup_hash
        ? await this.fileHistory.readBackup(sessionId, tracked.backup_hash)
        : null;
      const currentBytes = await this.fileHistory.readCurrent(fileKey);
      const oldContent = decode(oldBytes);
      const newContent = decode(currentBytes);
      const item: FileChangeItem = {
        path: fileKey,
        action: tracked.action,
        newContent,
        diff: buildLineDiff(oldContent, newContent),
      };
      if (tracked.action === "modified") item.oldContent = oldContent;
      return item;
    }));
    return {
      snapshot_id: snapshot?.snapshot_id ?? null,
      message_seq: snapshot?.message_seq ?? null,
      files,
    };
  }
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

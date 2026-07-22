export interface FileChangeLine {
  type: "added" | "removed" | "context";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface FileChangeItem {
  path: string;
  action: "modified" | "created";
  oldContent?: string;
  newContent: string;
  diff: FileChangeLine[];
}

export interface LatestFileChanges {
  snapshot_id: string | null;
  message_seq: number | null;
  files: FileChangeItem[];
}

export interface FileChangeApplication {
  getLatest(sessionId: string): Promise<LatestFileChanges>;
}

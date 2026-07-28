/** Promise-only file snapshot boundary used by session rollback and retry flows. */
export interface SessionHistoryPort {
  cleanup(sessionId: string): Promise<void>;
  makeSnapshot(sessionId: string, messageSeq: number): Promise<string | null>;
  hasSnapshots(sessionId: string): Promise<boolean>;
  rewind(sessionId: string, targetSeq: number): Promise<void>;
}

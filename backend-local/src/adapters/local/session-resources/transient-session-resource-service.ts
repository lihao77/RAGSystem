import fs from "node:fs";
import path from "node:path";

export interface TransientPruneResult {
  deleted: number;
  retained: number;
}

/** Cleans session-owned workspace files; observation scratch files live in os.tmpdir(). */
export class TransientSessionResourceService {
  private readonly sessionsRoot: string;

  constructor(dataRoot: string) {
    this.sessionsRoot = path.join(path.resolve(dataRoot), "sessions");
  }

  startPruning(): void {}

  stopPruning(): void {}

  async pruneExpired(): Promise<TransientPruneResult> {
    return { deleted: 0, retained: 0 };
  }

  cleanupSessionResources(sessionId: string): void {
    if (!isSafeSessionId(sessionId)) return;
    fs.rmSync(path.join(this.sessionsRoot, sessionId), { recursive: true, force: true });
  }
}

function isSafeSessionId(value: string): boolean {
  return Boolean(value) && value.length <= 200 && value !== "." && value !== ".." && !/[<>:"/\\|?*\u0000-\u001f]/.test(value);
}

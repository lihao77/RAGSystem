import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_LEASE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRIES = {
  retries: 140,
  minTimeout: 25,
  maxTimeout: 250,
  factor: 1.2,
  randomize: true,
} as const;

export interface ArtifactIndexLockOptions {
  staleMs?: number;
  updateMs?: number;
  retries?: number;
}

/** Cross-process lease backed by proper-lockfile's atomic mkdir lock and stale-lock heartbeat. */
export async function withArtifactIndexLock<T>(root: string, action: () => Promise<T>, options: ArtifactIndexLockOptions = {}): Promise<T> {
  await fs.promises.mkdir(root, { recursive: true });
  const target = path.join(root, "artifact_index.jsonl");
  const staleMs = options.staleMs ?? LOCK_LEASE_MS;
  const updateMs = options.updateMs ?? LOCK_UPDATE_MS;
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: staleMs,
    update: updateMs,
    retries: {
      ...LOCK_RETRIES,
      retries: options.retries ?? LOCK_RETRIES.retries,
    },
    onCompromised: (error) => { compromisedError = error; },
  });
  let lastWatchdogTick = Date.now();
  let watchdogDetectedStall = false;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastWatchdogTick >= staleMs) watchdogDetectedStall = true;
    lastWatchdogTick = now;
  }, Math.min(updateMs, 1_000));
  watchdog.unref?.();
  try {
    const result = await action();
    if (watchdogDetectedStall || Date.now() - lastWatchdogTick >= staleMs) {
      compromisedError ??= Object.assign(new Error("Artifact index lock lease may have been lost after an event-loop stall"), { code: "ECOMPROMISED" });
    }
    if (compromisedError) throw compromisedError;
    return result;
  } finally {
    if (watchdogDetectedStall || Date.now() - lastWatchdogTick >= staleMs) {
      compromisedError ??= Object.assign(new Error("Artifact index lock lease may have been lost after an event-loop stall"), { code: "ECOMPROMISED" });
    }
    clearInterval(watchdog);
    if (!compromisedError) await release();
  }
}

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

export interface LeaseLockOptions {
  staleMs?: number;
  updateMs?: number;
  retries?: number;
}

export type ArtifactIndexLockOptions = LeaseLockOptions;

/** Cross-process lease backed by proper-lockfile's atomic mkdir lock and stale-lock heartbeat. */
export async function withLeaseLock<T>(target: string, action: () => Promise<T>, options: LeaseLockOptions = {}): Promise<T> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
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
      compromisedError ??= compromisedLockError();
    }
    if (compromisedError) throw compromisedError;
    return result;
  } finally {
    if (watchdogDetectedStall || Date.now() - lastWatchdogTick >= staleMs) {
      compromisedError ??= compromisedLockError();
    }
    clearInterval(watchdog);
    if (!compromisedError) await release();
  }
}

/** Synchronous lease for short filesystem critical sections. */
export function withLeaseLockSync<T>(target: string, action: () => T, options: LeaseLockOptions = {}): T {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staleMs = options.staleMs ?? LOCK_LEASE_MS;
  let compromisedError: Error | undefined;
  const acquiredAt = Date.now();
  const release = lockfile.lockSync(target, {
    realpath: false,
    stale: staleMs,
    update: options.updateMs ?? LOCK_UPDATE_MS,
    retries: 0,
    onCompromised: (error) => { compromisedError = error; },
  });
  try {
    const result = action();
    if (Date.now() - acquiredAt >= staleMs) compromisedError ??= compromisedLockError();
    if (compromisedError) throw compromisedError;
    return result;
  } finally {
    if (Date.now() - acquiredAt >= staleMs) compromisedError ??= compromisedLockError();
    if (!compromisedError) release();
  }
}

export async function withArtifactIndexLock<T>(root: string, action: () => Promise<T>, options: ArtifactIndexLockOptions = {}): Promise<T> {
  return withLeaseLock(path.join(root, "artifact_index.jsonl"), action, options);
}

function compromisedLockError(): Error {
  return Object.assign(new Error("Lock lease may have been lost after an event-loop stall"), { code: "ECOMPROMISED" });
}

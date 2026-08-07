import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_LEASE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRIES = { retries: 140, minTimeout: 25, maxTimeout: 250, factor: 1.2, randomize: true } as const;

export interface LeaseLockOptions {
  staleMs?: number;
  updateMs?: number;
  retries?: number;
}

/** Cross-process lease for asynchronous critical sections. */
export async function withLeaseLock<T>(target: string, action: () => Promise<T>, options: LeaseLockOptions = {}): Promise<T> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const staleMs = options.staleMs ?? LOCK_LEASE_MS;
  const updateMs = options.updateMs ?? LOCK_UPDATE_MS;
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: staleMs,
    update: updateMs,
    retries: { ...LOCK_RETRIES, retries: options.retries ?? LOCK_RETRIES.retries },
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
    if (watchdogDetectedStall || Date.now() - lastWatchdogTick >= staleMs) compromisedError ??= compromisedLockError();
    if (compromisedError) throw compromisedError;
    return result;
  } finally {
    if (watchdogDetectedStall || Date.now() - lastWatchdogTick >= staleMs) compromisedError ??= compromisedLockError();
    clearInterval(watchdog);
    if (!compromisedError) await release();
  }
}

function compromisedLockError(): Error {
  return Object.assign(new Error("Lock lease may have been lost after an event-loop stall"), { code: "ECOMPROMISED" });
}

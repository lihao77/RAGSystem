import { spawn } from "node:child_process";

export function terminateProcessTree(pid: number | undefined, force: boolean): Promise<void> {
  if (!pid) {
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      const args = ["/pid", String(pid), "/t"];
      if (force) args.push("/f");
      let finished = false;
      let fallbackStarted = false;
      let fallbackTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        resolve();
      };
      const fallback = (): void => {
        if (fallbackStarted || finished) return;
        fallbackStarted = true;
        try {
          process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          // Process already exited.
        }
        void waitForExit(pid, 5_000).finally(finish);
      };
      try {
        const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
        fallbackTimer = setTimeout(fallback, 1_000);
        fallbackTimer.unref?.();
        killer.once("error", () => {
          fallback();
        });
        killer.once("exit", (code) => {
          if (code === 0) finish();
          else fallback();
        });
      } catch {
        fallback();
      }
    });
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  return Promise.resolve();
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

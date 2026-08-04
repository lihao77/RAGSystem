import { spawn } from "node:child_process";

export function terminateProcessTree(pid: number | undefined, force: boolean): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t"];
    if (force) {
      args.push("/f");
    }
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallback = (): void => {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // Process already exited.
      }
    };
    const fallbackTimer = setTimeout(fallback, 1_000);
    fallbackTimer.unref?.();
    killer.once("error", () => {
      clearTimeout(fallbackTimer);
      fallback();
    });
    killer.once("exit", (code) => {
      clearTimeout(fallbackTimer);
      if (code !== 0) fallback();
    });
    killer.unref();
    return;
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
}

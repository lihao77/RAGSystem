import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectHostShell,
  describeShellEnvironment,
  setHostShellOverrideResolver,
} from "../src/contracts/execution/shell-detection.js";

// 终端类型覆盖是 Windows 宿主概念；非 win32 平台 resolveOverride 恒返回 null。
const isWindows = process.platform === "win32";

function fakeBashExecutable(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-shell-detect-"));
  const file = path.join(dir, "bash.exe");
  fs.writeFileSync(file, "");
  return file;
}

describe("host shell detection override", () => {
  let originalEnvBash: string | undefined;

  beforeEach(() => {
    originalEnvBash = process.env.RAGSYSTEM_BASH;
  });

  afterEach(() => {
    setHostShellOverrideResolver(null);
    if (originalEnvBash === undefined) delete process.env.RAGSYSTEM_BASH;
    else process.env.RAGSYSTEM_BASH = originalEnvBash;
  });

  it.runIf(isWindows)("cmd override forces the Windows command shell", () => {
    setHostShellOverrideResolver(() => ({ type: "cmd" }));
    const detected = detectHostShell();
    expect(detected.shellKind).toBe("cmd");
    expect(detected.bashExecutable).toBeNull();
  });

  it.runIf(isWindows)("bash override uses an explicit existing path", () => {
    const fake = fakeBashExecutable();
    setHostShellOverrideResolver(() => ({ type: "bash", bashPath: fake }));
    const detected = detectHostShell();
    expect(detected.shellKind).toBe("bash");
    expect(detected.bashExecutable).toBe(fake);
    expect(detected.shellLabel).toBe("bash");
  });

  it.runIf(isWindows)("bash override with an unusable path falls back to the locate chain", () => {
    const fake = fakeBashExecutable();
    process.env.RAGSYSTEM_BASH = fake;
    setHostShellOverrideResolver(() => ({ type: "bash", bashPath: "Z:\\definitely\\missing\\bash.exe" }));
    const detected = detectHostShell();
    expect(detected.shellKind).toBe("bash");
    expect(detected.bashExecutable).toBe(fake);
  });

  it.runIf(isWindows)("resolver returning null keeps the auto detection chain", () => {
    setHostShellOverrideResolver(() => null);
    const detected = detectHostShell();
    expect(["bash", "cmd"]).toContain(detected.shellKind);
  });

  it("describeShellEnvironment keeps SaaS on POSIX regardless of override", () => {
    setHostShellOverrideResolver(() => ({ type: "cmd" }));
    const env = describeShellEnvironment("saas");
    expect(env.platform).toBe("linux");
    expect(env.shellSyntax).toBe("posix");
  });
});

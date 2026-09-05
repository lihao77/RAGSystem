import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ShellEnvironment } from "@ragsystem/agent-sdk";

/**
 * 宿主 shell 探测与运行环境描述。
 *
 * Windows 降级链（完整优先级）：
 * 1. `RAGSYSTEM_BASH` 环境变量显式指定的 bash 路径（存在才生效，否则视为未配置）；
 * 2. PATH 上的 bash.exe——跳过 WSL（System32\bash.exe 与 WindowsApps 壳），
 *    WSL bash 无法直接接受 Windows 工作区路径；
 * 3. Git for Windows 固定安装位置（Program Files / Program Files (x86) / 用户级安装）；
 * 4. 以上皆无 → 系统 shell（cmd.exe，即 node spawn shell:true 在 Windows 的实际行为）。
 *
 * 非 Windows 平台：命令经 `/bin/sh -c` 执行（node spawn shell:true），bashExecutable 为 null。
 * 探测结果进程内 memoize——依赖文件系统扫描，且运行期不会变化。
 */
export interface HostShellInfo {
  /** 检出的 bash 可执行文件绝对路径；无 bash（含非 Windows 平台）时为 null。 */
  bashExecutable: string | null;
  /** 实际执行命令的 shell 种类：写入工具 metadata 与提示词。 */
  shellKind: "bash" | "cmd" | "sh";
  /** 人类可读标签。 */
  shellLabel: string;
}

let cached: HostShellInfo | null = null;

export function detectHostShell(): HostShellInfo {
  if (!cached) {
    cached = detectHostShellUncached();
  }
  return cached;
}

function detectHostShellUncached(): HostShellInfo {
  if (process.platform !== "win32") {
    return { bashExecutable: null, shellKind: "sh", shellLabel: "sh" };
  }
  const fromEnv = process.env.RAGSYSTEM_BASH?.trim();
  if (fromEnv && path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) {
    return { bashExecutable: fromEnv, shellKind: "bash", shellLabel: bashLabel(fromEnv) };
  }
  const fromPath = findBashOnPath();
  if (fromPath) {
    return { bashExecutable: fromPath, shellKind: "bash", shellLabel: bashLabel(fromPath) };
  }
  const fromKnownLocations = findGitBashInstallations().find((candidate) => fs.existsSync(candidate));
  if (fromKnownLocations) {
    return { bashExecutable: fromKnownLocations, shellKind: "bash", shellLabel: bashLabel(fromKnownLocations) };
  }
  return {
    bashExecutable: null,
    shellKind: "cmd",
    shellLabel: path.basename(process.env.ComSpec ?? "cmd.exe"),
  };
}

function findBashOnPath(): string | null {
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "bash.exe");
    if (!fs.existsSync(candidate)) continue;
    if (isWslBash(candidate)) continue;
    return path.resolve(candidate);
  }
  return null;
}

/** WSL 的 bash.exe 无法直接接受 Windows 路径参数，不能作为工作 shell。
 *  子串匹配偏保守（自定义 \System32\ 目录下的 Cygwin 会被一并跳过）——
 *  误跳只是退回 Git 固定位置/系统 shell，方向安全。 */
function isWslBash(candidate: string): boolean {
  const normalized = path.resolve(candidate).toLowerCase().replaceAll("/", "\\");
  return normalized.includes("\\system32\\") || normalized.includes("\\windowsapps\\");
}

function findGitBashInstallations(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return [
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    path.join(programFilesX86, "Git", "bin", "bash.exe"),
    ...(localAppData ? [path.join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
  ];
}

function bashLabel(executable: string): string {
  const normalized = executable.toLowerCase().replaceAll("/", "\\");
  // "Git Bash" 是产品事实名称；其余（MSYS2/Cygwin 等）直接报程序名 bash。
  return normalized.includes("\\git\\") ? "Git Bash" : "bash";
}

/**
 * 提示词"运行环境"段的数据源：local 用宿主探测结果，saas 恒为沙箱 Linux。
 * 显式传入 detected 供测试注入；缺省用 memoize 的探测结果。
 */
export function describeShellEnvironment(
  deploymentKind: "local" | "saas",
  detected: HostShellInfo = detectHostShell(),
): ShellEnvironment {
  if (deploymentKind === "saas") {
    return {
      platform: "linux",
      shellLabel: "沙箱 shell（POSIX）",
      shellSyntax: "posix",
      pathStyle: "posix",
    };
  }
  const platform: ShellEnvironment["platform"] =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return {
    platform,
    osRelease: os.release(),
    arch: os.arch(),
    shellLabel: detected.shellLabel,
    shellSyntax: detected.shellKind === "cmd" ? "windows" : "posix",
    pathStyle: platform === "windows" ? "windows" : "posix",
  };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ShellEnvironment } from "@ragsystem/agent-sdk";

/**
 * 宿主 shell 探测与运行环境描述。
 *
 * 优先级：**终端类型覆盖**（setHostShellOverrideResolver 注册的惰性解析器，插件设置
 * 消费方注册）→ 自动检测链。覆盖与自动链共用 bash 定位段，仅生效判定不同。
 *
 * Windows 自动降级链（完整优先级）：
 * 1. `RAGSYSTEM_BASH` 环境变量显式指定的 bash 路径（存在才生效，否则视为未配置）；
 * 2. PATH 上的 bash.exe——跳过 WSL（System32\bash.exe 与 WindowsApps 壳），
 *    WSL bash 无法直接接受 Windows 工作区路径；
 * 3. Git for Windows 固定安装位置（Program Files / Program Files (x86) / 用户级安装）；
 * 4. 以上皆无 → 系统 shell（cmd.exe，即 node spawn shell:true 在 Windows 的实际行为）。
 *
 * 非 Windows 平台：命令经 `/bin/sh -c` 执行（node spawn shell:true），bashExecutable 为 null，
 * 终端类型覆盖被忽略（它是 Windows 宿主概念）。
 * 自动链探测结果进程内 memoize——依赖文件系统扫描，且运行期不会变化；覆盖路径不缓存。
 */
export interface HostShellInfo {
  /** 检出的 bash 可执行文件绝对路径；无 bash（含非 Windows 平台）时为 null。 */
  bashExecutable: string | null;
  /** 实际执行命令的 shell 种类：写入工具 metadata 与提示词。 */
  shellKind: "bash" | "cmd" | "sh";
  /** 人类可读标签。 */
  shellLabel: string;
}

/** 终端类型覆盖：由设置消费方（执行工具插件）声明，null/undefined 表示走自动检测链。 */
export type HostShellOverride =
  | { readonly type: "bash"; readonly bashPath?: string }
  | { readonly type: "cmd" };

let cached: HostShellInfo | null = null;
let overrideResolver: (() => HostShellOverride | null | undefined) | null = null;

/**
 * 注册宿主终端类型覆盖解析器。惰性求值：detectHostShell 每次解析都现调 resolver，
 * 设置变更后 execute_shell 实际执行与提示词"运行环境"段即刻一致（同源）。传 null 清除。
 */
export function setHostShellOverrideResolver(
  resolver: (() => HostShellOverride | null | undefined) | null,
): void {
  overrideResolver = resolver;
}

export function detectHostShell(): HostShellInfo {
  const overridden = resolveOverride(overrideResolver?.());
  if (overridden) return overridden;
  if (!cached) {
    cached = detectHostShellUncached();
  }
  return cached;
}

function resolveOverride(override: HostShellOverride | null | undefined): HostShellInfo | null {
  if (!override || process.platform !== "win32") return null;
  if (override.type === "cmd") return cmdShellInfo();
  const explicit = override.bashPath?.trim();
  if (explicit && path.isAbsolute(explicit) && fs.existsSync(explicit)) {
    return { bashExecutable: explicit, shellKind: "bash", shellLabel: bashLabel(explicit) };
  }
  // 选了 bash 但未给路径或路径失效：退回 bash 定位链（含 RAGSYSTEM_BASH），仍无则按 cmd 兜底。
  const located = locateBashExecutable();
  return located ? { bashExecutable: located, shellKind: "bash", shellLabel: bashLabel(located) } : cmdShellInfo();
}

function detectHostShellUncached(): HostShellInfo {
  if (process.platform !== "win32") {
    return { bashExecutable: null, shellKind: "sh", shellLabel: "sh" };
  }
  const bashExecutable = locateBashExecutable();
  return bashExecutable
    ? { bashExecutable, shellKind: "bash", shellLabel: bashLabel(bashExecutable) }
    : cmdShellInfo();
}

/** bash 定位链：RAGSYSTEM_BASH → PATH（跳过 WSL）→ Git 固定安装位置；无则 null。 */
function locateBashExecutable(): string | null {
  const fromEnv = process.env.RAGSYSTEM_BASH?.trim();
  if (fromEnv && path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  return findBashOnPath() ?? findGitBashInstallations().find((candidate) => fs.existsSync(candidate)) ?? null;
}

function cmdShellInfo(): HostShellInfo {
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
 * 提示词"运行环境"段的数据源：local 用宿主探测结果，sandbox 恒为沙箱 Linux。
 * 显式传入 detected 供测试注入；缺省在 local 分支内现取（sandbox 不触发探测）。
 */
export function describeShellEnvironment(
  deploymentKind: "local" | "sandbox",
  detected?: HostShellInfo,
): ShellEnvironment {
  if (deploymentKind === "sandbox") {
    return {
      platform: "linux",
      shellLabel: "沙箱 shell（POSIX）",
      shellSyntax: "posix",
      pathStyle: "posix",
    };
  }
  const info = detected ?? detectHostShell();
  const platform: ShellEnvironment["platform"] =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return {
    platform,
    osRelease: os.release(),
    arch: os.arch(),
    shellLabel: info.shellLabel,
    shellSyntax: info.shellKind === "cmd" ? "windows" : "posix",
    pathStyle: platform === "windows" ? "windows" : "posix",
  };
}

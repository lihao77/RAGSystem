import type { SystemConfigExtension, SystemConfigPort } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import type { HostShellOverride } from "@ragsystem/backend-core/contracts/execution/shell-detection.js";

/**
 * 终端执行环境设置组（插件设置，sourceExtension 归本插件）。
 *
 * 仅影响本地 Windows 宿主的 execute_shell 与提示词"运行环境"段（同源）；Sandbox/沙箱
 * 运行时固定 POSIX，不消费本组。值经 shell-detection 的惰性覆盖 resolver 生效，
 * 设置变更后无需重启。
 */
export const EXECUTION_SHELL_CONFIG_GROUP_KEY = "execution_shell";

export function createExecutionToolsSystemConfigExtension(): SystemConfigExtension {
  return {
    defaults: {
      [EXECUTION_SHELL_CONFIG_GROUP_KEY]: { shell_type: "auto", bash_path: "" },
    },
    groups: [
      {
        key: EXECUTION_SHELL_CONFIG_GROUP_KEY,
        label: "终端执行环境",
        description: "execute_shell 在本地 Windows 宿主使用的终端类型；Sandbox/沙箱运行时固定 POSIX，不适用",
        fields: [
          {
            key: "shell_type",
            label: "终端类型",
            type: "select",
            default: "auto",
            options: [
              { value: "auto", label: "自动检测" },
              { value: "bash", label: "Bash（Git Bash 等 POSIX shell）" },
              { value: "cmd", label: "cmd.exe（Windows 命令提示符）" },
            ],
            help: "自动检测按 RAGSYSTEM_BASH 环境变量 → PATH（跳过 WSL）→ Git 安装位 → cmd 降级链",
          },
          {
            key: "bash_path",
            label: "Bash 路径",
            type: "text",
            default: "",
            help: "bash.exe 绝对路径；终端类型选 Bash 时生效，留空按检测链查找，路径无效同样退回检测链",
          },
        ],
      },
    ],
  };
}

/** 从设置组读终端类型覆盖；未设置/自动检测/值非法时返回 null（走自动检测链）。 */
export function readHostShellOverride(systemConfig: SystemConfigPort): HostShellOverride | null {
  const section = systemConfig.getSection(EXECUTION_SHELL_CONFIG_GROUP_KEY);
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const record = section as Record<string, unknown>;
  if (record.shell_type === "bash") {
    const bashPath = typeof record.bash_path === "string" ? record.bash_path.trim() : "";
    return bashPath ? { type: "bash", bashPath } : { type: "bash" };
  }
  if (record.shell_type === "cmd") return { type: "cmd" };
  return null;
}

# shell 环境检测与 RAGSYSTEM_BASH

本地部署（backend-local）的终端类型有两个来源，优先级从高到低：

1. **插件设置**（推荐，运行期可改）：设置页 → 插件设置 → 执行工具插件 →「终端执行环境」组（`execution_shell`），可选自动检测 / 强制 Bash / 强制 cmd.exe，并可显式指定 bash.exe 路径。设置经 shell-detection 的惰性覆盖 resolver 生效——execute_shell 实际执行与系统提示词"运行环境"段同源读取，**改完即生效，无需重启**。
2. **自动检测链**：`RAGSYSTEM_BASH` 环境变量——必须指向真实存在的 bash.exe 绝对路径，用于固定 bash 或跳过 PATH 扫描（例如 bash 不在 PATH 里、或想在多个 Git 安装中指定某个）→ PATH 上的 bash.exe（跳过 WSL 发行版条目 `\system32\`、`\windowsapps\`，并剥离条目中的引号）→ Git 固定安装位置（Program Files、Program Files (x86)、LOCALAPPDATA 用户级安装）→ cmd.exe（`ComSpec`）。非 Windows 平台为 `sh`，且终端类型设置被忽略（Windows 宿主概念）。

选了 Bash 但路径留空或路径无效时，退回自动检测链的 bash 定位段，仍无 bash 则按 cmd 兜底。SaaS/沙箱运行时不消费该设置，固定声明为 Linux POSIX 沙箱。

检测/覆盖结果同时供两处消费：`execute_shell` 的实际执行（每次执行现解析），以及系统提示词"运行环境"段（POSIX / Windows cmd 语法指引按解析结果生成）。

验证方式：设置页把终端类型切到 cmd.exe 后，在会话中让模型执行 `dir`（cmd 语法）或查看系统提示词的"运行环境"段；或设置 `RAGSYSTEM_BASH=C:\Program Files\Git\bin\bash.exe` 后重启本地服务验证自动链。

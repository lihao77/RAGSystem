# shell 环境检测与 RAGSYSTEM_BASH

`execute_shell` 在本地部署（backend-local）下不写死 shell 路径，运行期按以下顺序检测宿主 shell（`backend-core/src/contracts/execution/shell-detection.ts`，进程内 memoize）：

1. `RAGSYSTEM_BASH` 环境变量——必须指向真实存在的 bash.exe 绝对路径，用于固定 bash 或跳过 PATH 扫描（例如 bash 不在 PATH 里、或想在多个 Git 安装中指定某个）；
2. PATH 上的 bash.exe——跳过 WSL 发行版条目（`\system32\`、`\windowsapps\`），并剥离条目中的引号；
3. Git 固定安装位置（Program Files、Program Files (x86)、LOCALAPPDATA 用户级安装）；
4. 以上皆无时降级为 cmd.exe（`ComSpec`），非 Windows 平台为 `sh`。

检测结果同时供两处消费：`execute_shell` 的实际执行，以及系统提示词"运行环境"段（POSIX / Windows cmd 语法指引按检测结果生成）。SaaS 部署不检测宿主，固定声明为 Linux POSIX 沙箱。

验证方式：设置 `RAGSYSTEM_BASH=C:\Program Files\Git\bin\bash.exe` 后启动本地服务，在会话中让模型执行 `echo $0` 或查看系统提示词的"运行环境"段。

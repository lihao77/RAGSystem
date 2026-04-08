# Claude Code 工具总览 vs RAGSystem 工具对比

> 生成时间：2026-04-03
> Claude Code 版本：claude-code-source-code（TypeScript）
> RAGSystem 版本：backend-fastapi（Python/FastAPI）

---

## 一、工具清单总览

### Claude Code（43 个工具）

| 类别 | 工具名 | 数量 |
|------|--------|------|
| 文件系统 | Read, Write, Edit, Glob, Grep, NotebookEdit | 6 |
| Shell 执行 | Bash, PowerShell | 2 |
| 网络 | WebFetch, WebSearch | 2 |
| 子 Agent | Agent, SendMessage, TaskStop | 3 |
| 任务管理 | TaskCreate, TaskGet, TaskUpdate, TaskList, TaskOutput, TodoWrite | 6 |
| 定时任务 | CronCreate, CronDelete, CronList | 3 |
| 多 Agent 团队 | TeamCreate, TeamDelete | 2 |
| Git 工作区 | EnterWorktree, ExitWorktree | 2 |
| 计划模式 | EnterPlanMode, ExitPlanMode | 2 |
| MCP 集成 | mcp, McpAuth, ListMcpResources, ReadMcpResource | 4 |
| 其他 | LSP, Skill, AskUserQuestion, Config, ToolSearch, Sleep, RemoteTrigger, StructuredOutput, SendUserMessage | 9 |

### RAGSystem（23 个工具）

| 类别 | 工具名 | 数量 |
|------|--------|------|
| 文件系统 | write_file, read_file, edit_file, preview_data_structure | 4 |
| Shell 执行 | execute_bash | 1 |
| 代码沙箱 | execute_code | 1 |
| 子 Agent | call_agent, list_child_agents, send_message | 3 |
| 记忆系统 | list_memory_index, read_memory_entry, write_memory, archive_memory | 4 |
| Skill 系统 | activate_skill, load_skill_resource, execute_skill_script, get_skill_info | 4 |
| 用户交互 | request_user_input | 1 |
| MCP 集成 | （动态，通过 mcp_gateway.py 代理）| 动态 |
| 任务管理 | ❌ 缺失 | 0 |
| 定时任务 | ❌ 缺失 | 0 |
| 多 Agent 团队 | ❌ 缺失 | 0 |
| Git 工作区 | ❌ 缺失 | 0 |
| 计划模式 | ❌ 缺失 | 0 |
| 网络 | ❌ 缺失 | 0 |

---

## 二、逐类型详细对比

---

### 类型 1：文件系统工具

#### 1.1 Read 文件（read_file vs FileReadTool）

| 维度 | RAGSystem `read_file` | Claude Code `Read` |
|------|----------------------|-------------------|
| **输入参数** | file_path, encoding, offset(行号), limit(行数) | file_path, offset, limit, **pages**(PDF页码范围) |
| **输出** | 文件内容文本 + metadata(total_lines, has_more, next_offset) | 文件内容（带行号前缀 cat -n 格式） |
| **大文件策略** | file_size > 阈值时发送 USER_APPROVAL_REQUIRED 事件，弹用户确认 | 依赖 token 计数，超限抛 MaxFileReadTokenExceededError |
| **结果落盘** | 无机制，直接返回 | **maxResultSizeChars: Infinity**（显式禁止落盘，防止 Read→file→Read 循环） |
| **设备路径阻断** | 无 | 阻断 /dev/zero、/dev/random、/proc/\<pid\>/fd/* 等 11 类危险路径 |
| **图片支持** | 无 | png/jpg/jpeg/gif/webp → base64 返回 |
| **PDF 支持** | 无 | pages 参数指定页码范围，最多 20 页 |
| **Notebook 支持** | 无 | .ipynb → 提取全部 cell + 输出 |
| **并发声明** | 无 | `isConcurrencySafe: true`，调度器据此并行执行 |
| **文件类型识别** | 无 | detectSessionFileType()，识别 session_memory / transcript 文件 |
| **macOS 特殊路径** | 无 | U+202F thin-space 截图路径备用解析 |
| **注册订阅** | 无 | registerFileReadListener()，读取后 pub/sub 通知（用于 nestedMemory） |

**差距总结**：RAGSystem 缺少设备路径安全拦截、多媒体文件支持（图片/PDF/Notebook）、并发安全声明；大文件策略基于文件大小审批而非 token 计数。

---

#### 1.2 Write 文件（write_file vs FileWriteTool）

| 维度 | RAGSystem `write_file` | Claude Code `Write` |
|------|------------------------|---------------------|
| **输入参数** | content, file_path(可省略自动分配), encoding, mode(text/json) | file_path(绝对路径,必填), content |
| **路径策略** | 省略路径时自动分配受管目录路径 | 必须提供绝对路径 |
| **输出结构** | {file_path, file_size, display_path} | **{type: create\|update, filePath, content, structuredPatch, originalFile, gitDiff}** |
| **diff 输出** | 无 | structuredPatch（hunk 数组）+ gitDiff（additions/deletions/changes） |
| **路径展开** | resolve_managed_path() 归一化到受管目录 | backfillObservableInput() 展开 ~ 和相对路径 |
| **编辑器通知** | 无 | notifyVscodeFileUpdated()，通知 VSCode 扩展刷新文件 |
| **文件历史** | 无 | fileHistoryTrackEdit()，追踪写入历史 |
| **Schema 严格度** | 手写 JSON Schema dict | Zod strict: true |

**差距总结**：RAGSystem 有自动路径分配能力（Claude Code 没有），Claude Code 输出更丰富（含 diff/gitDiff），且集成 VSCode 通知和文件历史追踪。

---

#### 1.3 Edit 文件（edit_file vs FileEditTool）

| 维度 | RAGSystem `edit_file` | Claude Code `Edit` |
|------|----------------------|-------------------|
| **输入参数** | file_path, old_string, new_string, encoding, replace_all(bool) | file_path, old_string, new_string, replace_all(semanticBoolean) |
| **唯一性检查** | old_string 计次，0次报错，多次且非replace_all报错 | 相同逻辑 |
| **diff 输出** | difflib.unified_diff 文本，超2000字节截断 | **structuredPatch(hunk数组) + gitDiff** |
| **竞态检测** | ❌ 无 | ✅ 编辑前校验文件 mtime + readFileState 缓存，文件被第三方修改抛 FILE_UNEXPECTEDLY_MODIFIED_ERROR；Windows 降级为内容 hash 比较 |
| **文件大小限制** | 无明确上限 | MAX_EDIT_FILE_SIZE = 1 GiB |
| **LSP 集成** | ❌ 无 | ✅ 编辑后清除 LSP diagnostics 缓存 |
| **编辑器通知** | 无 | notifyVscodeFileUpdated() |
| **并发声明** | 无 | isConcurrencySafe: false（写操作，防并发） |

**差距总结**：**最大差距是竞态检测缺失**。RAGSystem 在多 Agent 并行场景下，两个 Agent 同时 edit 同一文件会导致静默数据丢失。Claude Code 通过 mtime 校验完整防护。

---

#### 1.4 文件搜索（无对应工具 vs Glob/Grep）

| 维度 | RAGSystem | Claude Code `Glob` | Claude Code `Grep` |
|------|-----------|-------------------|-------------------|
| **工具存在** | ❌ 无独立 Glob/Grep 工具 | ✅ | ✅ |
| **Glob 能力** | 通过 execute_bash 调用 find 命令实现 | pattern + path，按 mtime 排序，最多 100 文件，UNC 路径安全检查 | — |
| **Grep 能力** | 通过 execute_bash 调用 grep/rg 实现 | — | ripgrep 后端，支持 -A/-B/-C/-n/-i/type/output_mode/head_limit/offset/multiline |
| **并发安全** | execute_bash 含安全检查链路 | isConcurrencySafe: true（直接并行） | isConcurrencySafe: true |
| **性能** | 走完整 bash 审批流程 | 直接原生调用 | 直接原生调用 |
| **VCS 目录排除** | 无 | UNC 检查 | .git/.svn/.hg/.bzr/.jj 自动排除 |

**差距总结**：RAGSystem 没有独立文件搜索工具，强制通过 execute_bash 实现，带来不必要的审批链路和性能开销。这是**高优先级缺口**。

---

#### 1.5 Notebook 编辑（无对应 vs NotebookEdit）

| 维度 | RAGSystem | Claude Code `NotebookEdit` |
|------|-----------|---------------------------|
| **工具存在** | ❌ 无 | ✅ |
| **Cell 操作** | — | replace / insert / delete 三种 edit_mode |
| **Cell 类型** | — | code / markdown |
| **适用场景** | — | .ipynb 文件，数据科学/Jupyter 场景 |

---

### 类型 2：Shell 执行工具

#### 2.1 Bash 工具（execute_bash vs BashTool）

| 维度 | RAGSystem `execute_bash` | Claude Code `Bash` |
|------|--------------------------|-------------------|
| **输入参数** | command, working_dir, working_dir_space, timeout(1-600), run_in_background, description | command, timeout(ms), description, run_in_background, **dangerouslyDisableSandbox** |
| **工作目录** | 三空间 workspace/transient/exports，通过 resolve_managed_directory 解析 | 无空间概念，使用 cwd（当前工作目录） |
| **最大超时** | 600 秒 | 无硬编码上限（由 timeout 参数决定） |
| **输出截断** | stdout 50K 字符，stderr 2K 字节 | maxResultSizeChars 系统级落盘（无单工具截断） |
| **进度上报** | 每 2.0 秒发布 TOOL_PROGRESS 事件 | PROGRESS_THRESHOLD_MS=2000，onProgress 回调 |
| **后台执行** | BackgroundTaskManager.spawn_bash()，返回 background_task_id | run_in_background=true，注册到 AppState 任务列表 |
| **自动后台化** | ❌ 无 | ✅ ASSISTANT_BLOCKING_BUDGET_MS=15000，超时 AI 主动建议后台化；CLAUDE_AUTO_BACKGROUND_TASKS 环境变量或 GrowthBook feature flag 控制 |
| **持久 Shell** | ❌ 无，采用每次新进程的无状态执行模型 | ❌ 每次新进程（无持久 shell） |
| **Windows 支持** | ✅ 检测 Git Bash 路径 | ✅ 通过 PowerShellTool 镜像实现 |

##### 安全模型对比（核心差距）

| 安全维度 | RAGSystem | Claude Code |
|----------|-----------|-------------|
| **安全检查方式** | 字符串正则 + 模式匹配（12 条规则） | **tree-sitter AST 解析 + 字符状态机（23 个 Check ID）** |
| **命令替换检测** | 禁止 `$()` 和反引号 | 禁止 `$(` `${` `$[` `~[` `<(` `>(` `=(` 及 Zsh glob qualifiers |
| **Zsh 危险语法** | ❌ 未检测 | ✅ 检测 `=cmd`（等号展开）、`zmodload`、`ztcp`、`zsocket`、`zpty` 等 |
| **heredoc 处理** | 禁止所有含 heredoc 的命令 | ✅ isSafeHeredoc() 精确识别安全 heredoc 模式（`$(cat <<'DELIM'...)`），允许安全形式 |
| **引号状态机** | 简单正则，可被引号绕过 | extractQuotedContent() 逐字符状态机追踪 inSingleQuote/inDoubleQuote/escaped |
| **前缀规则建议** | 无 | suggestionForExactCommand() 自动生成最优权限规则建议（`git:*` 而非 `git commit:*`） |
| **AI 分类器集成** | ❌ 无 | ✅ BASH_CLASSIFIER feature flag，LLM 分类高危命令（toAutoClassifierInput 接口） |
| **子命令分析上限** | 无限制 | MAX_SUBCOMMANDS_FOR_SECURITY_CHECK=50，超过 fallback to 'ask'（防止 DoS） |
| **sleep 检测** | ❌ 无 | ✅ detectBlockedSleepPattern()，`sleep N`（N≥2）触发警告 |
| **BARE_SHELL_PREFIXES 阻断** | ❌ 无明确机制 | ✅ sh/bash/sudo/xargs/env/nice/stdbuf/nohup 等不生成权限规则（防止绕过） |
| **命令分类集合** | 6 类：READ_ONLY/WRITE/DESTRUCTIVE/NETWORK/INTERPRETER/UNKNOWN | READ/WRITE/LIST/SILENT 四语义分组 + 专用集合（BASH_SEARCH_COMMANDS 等） |
| **环境变量禁止** | PATH/LD_PRELOAD/LD_LIBRARY_PATH/PYTHONPATH/DYLD_* 等 | 无专用规则（依赖 AST 全面检测） |

**差距总结**：RAGSystem 的 Bash 安全是字符串规则，Claude Code 是 AST + 状态机，**RAGSystem 存在被 Zsh 等号展开、引号嵌套等语法绕过的风险**。

---

### 类型 3：代码沙箱（execute_code，RAGSystem 独有）

| 维度 | RAGSystem `execute_code` | Claude Code |
|------|--------------------------|-------------|
| **是否存在** | ✅ | ❌ 无独立代码沙箱（用 Bash 实现） |
| **隔离机制** | multiprocessing spawn + Pipe 双工 IPC | — |
| **禁止模块** | os/sys/subprocess/shutil/socket（FORBIDDEN_MODULES） | — |
| **允许模块** | math/json/re/csv/datetime 等 17 个安全模块 | — |
| **静态检查** | ast.parse() + 正则，拦截 __import__/eval/exec/globals/locals/compile | — |
| **工具调用** | 子进程可通过 IPC call_tool 调用宿主工具 | — |
| **沙箱审批** | 子进程发 approval_request 消息，宿主暂停执行 | — |
| **超时扣除** | paused_duration 审批暂停时间从 timeout 中排除 | — |
| **注入 API** | safe_open, save_file, path_ops, SANDBOX_DIR 等 | — |

**评价**：RAGSystem 在代码沙箱方面比 Claude Code 更完善，这是 RAGSystem 的特色能力。

---

### 类型 4：子 Agent 工具

#### 4.1 创建/调用 Agent（call_agent vs AgentTool）

| 维度 | RAGSystem `call_agent` | Claude Code `Agent` |
|------|------------------------|---------------------|
| **输入参数** | agent_name, task, context_hint | description(3-5词), prompt, subagent_type?, model?(sonnet/opus/haiku), run_in_background?, name?, team_name?, mode?, isolation?, cwd? |
| **模型选择** | 无（固定使用配置模型） | model 参数动态选择 sonnet/opus/haiku |
| **隔离模式** | 无 | isolation: "worktree"（创建 git worktree 隔离副本） |
| **权限白名单** | agent_config.delegation.enabled_agents 许可名单校验 | filterDeniedAgents() 权限规则过滤 |
| **自委托检测** | ✅ 禁止 agent 委托自身 | ✅ 类似检查 |
| **自动后台化** | ❌ 无 | ✅ 超 ASSISTANT_BLOCKING_BUDGET_MS 时 AI 主动建议后台化 |
| **子 Agent ID** | child_agent_id="child_{uuid4()}" | agentId，注册到 AppState |
| **thread_key** | ✅ "child:{child_agent_id}"，支持续接 | 通过 agentId 追踪 |
| **异步/后台** | run_in_background 参数 | run_in_background + TaskOutput 读结果 |
| **团队集成** | ❌ 无 | team_name 参数绑定到团队 |

---

#### 4.2 续接消息（send_message vs SendMessageTool）

| 维度 | RAGSystem `send_message` | Claude Code `SendMessage` |
|------|--------------------------|--------------------------|
| **输入参数** | child_agent_id, message | to(名称/*/uds:/bridge:), summary?, message(string或结构化) |
| **消息类型** | 纯文本 | ✅ 支持结构化消息：shutdown_request/shutdown_response/plan_approval_response |
| **广播** | ❌ 无 | ✅ to="*" 广播所有 teammates |
| **跨会话** | ❌ 无 | ✅ bridge:\<session-id\> 跨机器通信（需 bypass 权限，防 prompt 注入） |
| **路由机制** | session thread_key 查找 | 5 层路由：UDS bridge → UDS socket → in-process agentId → 磁盘 transcript 恢复 → mailbox |
| **关机协议** | ❌ 无 | ✅ shutdown_request → Agent 响应 → abort()/gracefulShutdown(0) |
| **计划审批** | ❌ 无 | ✅ plan_approval_response 触发计划模式退出流程 |
| **延迟加载** | 否 | shouldDefer: true（需先 ToolSearch 发现） |
| **状态检查** | 检查 status=="active" | 自动 resume 已停止的 agent |

**差距总结**：RAGSystem 的 send_message 只是简单的 thread 续接，Claude Code 的 SendMessage 是完整的 Agent 间协议层（广播、跨会话、结构化消息、关机/计划审批协议）。

---

#### 4.3 列出子 Agent（list_child_agents vs 无对应）

| 维度 | RAGSystem `list_child_agents` | Claude Code |
|------|-------------------------------|-------------|
| **是否存在** | ✅ | TaskListTool 含 owner 字段，间接反映 agent 占有关系 |
| **过滤** | agent_name 过滤，limit(1-100) | — |
| **返回字段** | child_agent_id, agent_name, status, last_run_id, created_at, updated_at | — |

---

### 类型 5：任务管理工具（RAGSystem 完全缺失）

> RAGSystem **无任何任务管理工具**，Claude Code 有完整的 6 个工具体系。

#### 5.1 TaskCreate

| 参数 | 类型 | 说明 |
|------|------|------|
| subject | string(必填) | 任务标题（命令式形式） |
| description | string(必填) | 详细描述和验收标准 |
| activeForm | string(可选) | 进行中时 spinner 显示的现在进行时文本 |
| metadata | Record<string, unknown>(可选) | 任意附加元数据 |

**设计亮点**：
- 初始 status 固定为 `pending`（不允许创建时直接设 in_progress）
- executeTaskCreatedHooks() 钩子，失败时自动回滚刚创建的任务
- 成功后自动展开任务列表面板（setAppState expandedView=tasks）
- toAutoClassifierInput 返回 subject（用于安全分类器）

---

#### 5.2 TaskGet

- **参数**：taskId(string, 必填)
- **输出**：{task: {id, subject, description, status, blocks[], blockedBy[]} | null}
- **设计**：任务不存在返回 task:null 而非报错；返回完整依赖关系图（blocks/blockedBy）

---

#### 5.3 TaskUpdate

| 参数 | 类型 | 说明 |
|------|------|------|
| taskId | string(必填) | 目标任务 ID |
| status | pending/in_progress/completed/deleted | deleted 为特殊删除操作 |
| addBlocks | string[] | 追加「本任务阻塞哪些」关系 |
| addBlockedBy | string[] | 追加「被哪些阻塞」关系 |
| owner | string | 新拥有者（变更时自动发 mailbox 通知） |
| metadata | Record | null 值删除 key（patch merge 语义） |

**设计亮点**：
- success=false 是「良性失败」，不作为 error（避免取消 sibling tool）
- status=completed 先执行 executeTaskCompletedHooks()，失败则拒绝变更
- verificationNudgeNeeded：全任务完成且数量≥3、无验证任务时，自动提示创建验证子 Agent
- owner 变更通过 writeToMailbox() 发送 task_assignment 消息

---

#### 5.4 TaskList

- **参数**：无
- **输出**：{tasks: [{id, subject, status, owner?, blockedBy[]}]}
- **设计**：过滤 metadata._internal=true 的内部任务；blockedBy 动态过滤已 completed 的阻塞关系

---

#### 5.5 TaskOutput（读取后台任务结果）

| 参数 | 说明 |
|------|------|
| task_id | 后台任务 ID |
| block | 是否等待完成（默认 true） |
| timeout | 最大等待毫秒（0-600000，默认 30000） |

**输出**：retrieval_status(success/timeout/not_ready) + task 详情（含 exitCode/output/error）

**设计亮点**：
- block=false 立即返回当前状态（非阻塞轮询）
- 100ms 间隔轮询，超时返回 not_ready
- aliases: ['AgentOutputTool', 'BashOutputTool']（向后兼容）

---

#### 5.6 TaskStop（停止后台任务）

- **参数**：task_id 或 shell_id（兼容旧 KillShell 工具名）
- **设计**：任务不为 running 状态时报错（errorCode=3）；aliases: ['KillShell']

---

### 类型 6：定时任务工具（RAGSystem 完全缺失）

> RAGSystem **无任何定时任务能力**。

#### 6.1 CronCreate

| 参数 | 说明 |
|------|------|
| cron | 标准 5 字段 cron（本地时区，如 "*/5 * * * *"） |
| prompt | 触发时入队的 prompt 字符串 |
| recurring | true=周期触发，false=单次触发后自删（默认 true） |
| durable | true=持久化到 .claude/scheduled_tasks.json（默认 false） |

**设计亮点**：
- MAX_JOBS=50，超限报错
- recurring cron 3 天后自动过期（防止 session 泄漏）
- teammate context 禁止 durable（重启后 agentId 失效导致孤立）
- validateInput 校验下一年内必须有匹配时间点（防止无效 cron）

---

#### 6.2 CronDelete / CronList

- **CronDelete**：teammate 只能删自己的 cron（agentId 校验），跨 agent 删除报错
- **CronList**：teammate 只看自己的 cron；team lead 看全部；durable=false 时省略该字段

---

### 类型 7：多 Agent 团队工具（RAGSystem 完全缺失）

#### 7.1 TeamCreate

**参数**：team_name(必填), description(可选), agent_type(可选)

**设计亮点**：
- generateUniqueTeamName()：同名时生成 random word slug，不报错
- resetTaskList()：每个 team 任务编号从 1 重新开始
- setLeaderTeamName()：team lead 的 getTaskListId() 返回 team name 而非 sessionId
- team lead 不设 CLAUDE_CODE_AGENT_ID（不被误识别为 teammate）
- registerTeamForSessionCleanup()：会话结束自动清理 team 目录

#### 7.2 TeamDelete

- 无参数（从 appState 读取当前 team）
- 删除前检查是否有活跃成员（isActive !== false），有则返回 success=false 要求先 shutdown

---

### 类型 8：Git 工作区工具（RAGSystem 完全缺失）

#### 8.1 EnterWorktree

**参数**：name(可选，slug 格式，最长 64 字符)

**设计亮点**：
- 防止重复进入（scope guard：getCurrentWorktreeSession() 非空则报错）
- 从 worktree 内部调用时自动回退到主仓库根再创建新 worktree
- process.chdir + setCwd + setOriginalCwd 三处同步切换工作目录
- 清空 systemPromptSections / memoryFileCaches / plansDirectory 缓存（防止旧路径残留）

#### 8.2 ExitWorktree

**参数**：action(keep/remove), discard_changes(bool，remove 时有未提交变更必须为 true)

**设计亮点**：
- countWorktreeChanges() 返回 null 时 fail-closed 拒绝删除（git 失败视为有变更）
- restoreSessionToOriginalCwd() 精确还原：仅当 projectRoot==originalCwd 时才还原 projectRoot
- isDestructive(input) = action==='remove'（触发额外确认）
- tmux session：keep 时保留并返回 session name，remove 时 kill

---

### 类型 9：计划模式工具（RAGSystem 完全缺失）

#### 9.1 EnterPlanMode

- 无参数
- 设置 appState 为 plan 模式（只读探索，禁止写操作）
- agent 上下文中禁止调用（agentId 存在时报错）
- KAIROS_CHANNELS 激活时禁用（防止无终端 UI 的无法退出状态）

#### 9.2 ExitPlanMode

| 参数 | 说明 |
|------|------|
| allowedPrompts | [{tool: 'Bash', prompt: string}] 实现计划所需的权限声明 |

**三条执行路径**：
1. **teammate**：写 plan_approval_request 到 team-lead mailbox，等待 inbox 回复（awaitingLeaderApproval=true）
2. **非 teammate agent**：读取 plan 文件，返回内容供父 agent 读取
3. **普通用户**：弹确认 UI（checkPermissions 返回 behavior=ask），确认后恢复 prePlanMode

**设计亮点**：
- auto mode gate 回路断路器：prePlanMode=auto 但 gate 关闭时 fallback 到 default 并通知
- hasTaskTool=true 时在结果中提示可用 TeamCreate 并行化

---

### 类型 10：网络工具（RAGSystem 完全缺失）

#### 10.1 WebFetch

| 参数 | 说明 |
|------|------|
| url | 目标 URL（必填） |
| prompt | 对抓取内容执行的 prompt（必填） |

**设计亮点**：
- 权限粒度为 domain（hostname），而非整个工具
- preapproved host 快速通过，无需确认
- 跨 host 重定向检测（301/307/308），返回 REDIRECT DETECTED 消息要求模型再次调用
- preapproved + text/markdown + 内容<MAX_MARKDOWN_LENGTH 时直接返回原始内容（不走 AI 处理）
- 二进制内容（PDF 等）保存磁盘，result 末尾附加路径

#### 10.2 WebSearch

| 参数 | 说明 |
|------|------|
| query | 搜索词（最少 2 字符） |
| allowed_domains | 仅返回这些域的结果 |
| blocked_domains | 排除这些域的结果 |

**设计亮点**：
- 底层调用 Anthropic BetaWebSearchTool20250305，单次最多 8 次 web 搜索
- feature flag `tengu_plum_vx3`：使用 Haiku 小模型 + toolChoice 强制搜索（降本）
- allowed_domains 和 blocked_domains 互斥，同时指定报错
- results 为混合类型 (SearchResult | string)[]：文本注释和搜索结果交替排列
- 末尾强制附加 REMINDER 提示引用 sources

---

### 类型 11：用户交互工具

#### 11.1 request_user_input vs AskUserQuestion

| 维度 | RAGSystem `request_user_input` | Claude Code `AskUserQuestion` |
|------|-------------------------------|-------------------------------|
| **输入类型** | prompt(文本), input_type(text/select), options(list) | questions 数组(1-4题)，每题含 header/options(2-4项)/multiSelect |
| **多题支持** | ❌ 单次只问一个问题 | ✅ 最多 4 题同时呈现 |
| **多选支持** | ❌ select 类型单选 | ✅ multiSelect=true 支持多选，答案逗号分隔 |
| **预填答案** | ❌ 无 | ✅ answers 参数预填（SDK 场景） |
| **注解** | ❌ 无 | ✅ annotations 注解（用于 preview 选项的额外说明） |
| **元数据** | ❌ 无 | ✅ metadata（用于分析追踪，如 source="remember"） |
| **唯一性校验** | ❌ 无 | ✅ 所有 question 文本唯一；每题 option label 唯一 |
| **HTML preview** | ❌ 无 | ✅ options 可带 preview（Markdown 渲染，需含 HTML 标签，禁止 script/style） |
| **并发安全** | 无声明 | isConcurrencySafe: true, isReadOnly: true |
| **降级处理** | 无 session_id 时返回空字符串 + degraded=True | KAIROS_CHANNELS 激活时禁用 |
| **延迟加载** | 否 | shouldDefer: true |

**差距总结**：RAGSystem 的用户交互仅支持单问题文本/单选，Claude Code 支持结构化多题问卷、多选、预填答案、HTML preview，交互体验质量差距显著。

---

### 类型 12：工具发现机制

#### ToolSearch（RAGSystem 缺失）

| 维度 | RAGSystem | Claude Code `ToolSearch` |
|------|-----------|--------------------------|
| **是否存在** | ❌ 无 | ✅ |
| **触发机制** | 所有工具常驻 system prompt | shouldDefer=true 的工具不在初始 prompt 中展示 |
| **查找方式** | — | query="keyword" 关键词搜索 或 query="select:ToolName" 直接选取 |
| **打分逻辑** | — | tool name 精确+10、部分+5；searchHint 匹配+4；description 匹配+2；MCP tool 各+1~2 |
| **AND 过滤** | — | `+term` 语法必须包含该 term |
| **结果缓存** | — | lodash memoize 按 tool name 缓存 description，deferred 集合变化时清空 |
| **token 节省** | — | 大规模 MCP 场景下数十到上百工具的 schema 不塞 system prompt |

---

### 类型 13：记忆系统（RAGSystem 特有）

> Claude Code 无对应工具，这是 RAGSystem 的核心特色能力。

| 工具 | 功能 | 特点 |
|------|------|------|
| list_memory_index | 读取 MEMORY.md 索引头部 | 四层 scope：project/session/agent/workspace |
| read_memory_entry | 读取具体记忆文件 | scope 权限门控 |
| write_memory | 写入结构化记忆 | name/description/memory_type/why/how_to_apply |
| archive_memory | 归档（软删除）记忆 | 保留历史，不硬删除 |

**权限门控**：_ensure_memory_enabled() + _ensure_scope_allowed()，按 agent 配置精细控制读/写/归档权限。

---

### 类型 14：Skill 系统（RAGSystem 特有）

> Claude Code 有 Skill 工具但语义不同（调用 slash command）。

| 工具 | 功能 |
|------|------|
| activate_skill | 加载 SKILL.md，获取能力说明 |
| load_skill_resource | 读取 Skill 包内资源文件 |
| execute_skill_script | 执行 Skill 脚本，含 artifact 协议（可视化输出持久化） |
| get_skill_info | 获取 Skill 元信息（名称/描述/脚本列表） |

---

## 三、设计模式对比

| 设计维度 | RAGSystem | Claude Code |
|----------|-----------|-------------|
| **工具定义方式** | @tool() 装饰器 + 手写 JSON Schema dict | buildTool(def) 工厂函数 + Zod Schema（类型安全） |
| **Schema 初始化** | 模块加载时直接初始化 | lazySchema()，延迟初始化，避免循环依赖和 TDZ |
| **权限来源** | 三态 allow/deny/ask，单一来源 | 7 层来源优先级（system→policy→project→local→flag→cliArg→session），每条规则 source 可追溯 |
| **并发安全声明** | ❌ 无工具级并发声明 | ✅ isConcurrencySafe(input) 动态声明，调度器据此决定并行策略 |
| **结果大小控制** | 工具内硬截断（50K stdout） | maxResultSizeChars 字段 + 系统级 MAX_TOOL_RESULTS_PER_MESSAGE_CHARS=200K 双重保护 |
| **工具延迟加载** | ❌ 全量常驻 system prompt | ✅ shouldDefer=true + ToolSearch 按需发现 |
| **fail-closed 原则** | 部分实现 | TOOL_DEFAULTS 所有权限相关默认值取保守侧 |
| **工具钩子** | 无（approval 钩子除外） | PreToolUse/PostToolUse/session_start/pre_compact/post_compact |
| **AI 分类器接口** | ❌ 无 | ✅ toAutoClassifierInput() 标准接口，每个工具可接入 LLM 分类 |
| **编辑竞态保护** | ❌ 无 | ✅ mtime + hash 双重校验，Windows 降级为内容比较 |
| **进度回调** | EventBus TOOL_PROGRESS 事件 | onProgress(chunk) 回调参数，更通用 |

---

## 四、缺口优先级汇总

### 高优先级（功能缺失影响 Agent 自治能力）

| 序号 | 缺口 | 影响 |
|------|------|------|
| 1 | **TaskCreate/Get/Update/List** | Agent 无法自我分解任务、追踪进度、管理依赖 |
| 2 | **AskUserQuestion 升级** | 当前单问题单选，无法支持结构化多选问卷 |
| 3 | **TaskOutput / TaskStop** | 无法读取后台任务结果，无法停止失控任务 |
| 4 | **Glob / Grep 独立工具** | 文件搜索必须走 execute_bash 审批链路，性能低且引入不必要风险 |

### 中优先级（安全和架构改进）

| 序号 | 缺口 | 影响 |
|------|------|------|
| 5 | **Bash AST 安全升级** | 字符串规则可被 Zsh 等号展开等语法绕过 |
| 6 | **FileEdit 竞态检测** | 多 Agent 并行编辑同一文件会静默丢失数据 |
| 7 | **CronCreate/Delete/List** | 无法在 session 内调度定时/一次性任务 |
| 8 | **ToolSearch 延迟加载** | 工具数量增加后 system prompt 膨胀，token 浪费 |
| 9 | **isConcurrencySafe 声明** | 调度器无法安全并行执行只读工具 |

### 低优先级（架构级，实现成本高）

| 序号 | 缺口 | 影响 |
|------|------|------|
| 10 | **TeamCreate/Delete** | 无 Agent Swarm 团队协作能力 |
| 11 | **EnterWorktree/ExitWorktree** | 无 git 工作区隔离，多 Agent 并行开发互相干扰 |
| 12 | **EnterPlanMode/ExitPlanMode** | 无计划审批门控，Agent 可直接执行写操作 |
| 13 | **WebFetch/WebSearch** | 无网络信息获取能力 |
| 14 | **并发预算控制** | N 个并行工具合计输出可能击穿上下文窗口 |

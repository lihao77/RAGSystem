# 后端架构总览

> 变更代码后请同步更新本文档。

## 目录结构

```
backend-fastapi/
├── agents/                    # 智能体系统
│   ├── core/                  # 基础设施（BaseAgent, Context, Orchestrator, Registry）
│   ├── implementations/       # Agent 实现
│   │   └── orchestrator/      # 统一的通用 ReAct/编排 Agent 实现
│   ├── config/                # AgentConfig 配置加载
│   ├── context/               # 上下文管道、压缩、观察格式化
│   ├── events/                # EventBus、EventPublisher、SSEAdapter
│   ├── streaming/             # XML 流式解析（StreamingXMLParser, tool_xml_parser）
│   ├── skills/                # Skills 目录（每个 Skill 一个子目录）
│   ├── monitoring/            # 指标收集、观察窗口
│   ├── recovery/              # 检查点恢复
│   └── tests/                 # pytest 测试
├── tools/                     # 工具系统（详见 tools.md）
│   ├── contracts/             # ToolContract / ToolExecutionResult / ToolPermission 纯定义层
│   ├── runtime/               # bootstrap / discovery / approval / execute 运行时层
│   ├── local/                 # 本地工具真实实现层
│   ├── refs/                  # 结果引用与占位符解析
│   ├── artifacts/             # 可视化 artifact 子域
│   └── paths/                 # 全局路径治理
├── api/v1/                    # FastAPI 路由层
├── runtime/                   # RuntimeContainer 中央容器
├── model_adapter/             # LLM Provider 统一适配
├── mcp/                       # MCP 协议支持
├── services/                  # 业务服务层
├── application/               # 应用层（会话、协作）
├── capabilities/              # 能力模块（文档检索、向量检索、MCP）
├── config/yaml/               # 系统级 YAML 配置
├── execution/                 # 执行层（持久化、可观测性）
├── lifespan.py                # 启动生命周期
├── main.py                    # 应用入口
└── data/                      # 数据根目录（可通过 RAG_DATA_ROOT 环境变量覆盖）
    ├── db/                    # 数据库文件（ragsystem.db, checkpoints.db）
    ├── monitoring/
    │   └── session_traces/    # session/run 级调试追踪
    └── sessions/
        └── <session_id>/
            ├── sandbox/       # execute_code 沙箱目录
            ├── workspace/     # 默认会话工作空间
            ├── transient/     # 临时中间数据 / observation 落盘
            ├── uploads/       # 用户上传文件
            ├── visualizations/# 可视化 artifact
            └── exports/       # 导出文件（可包含 <run_id>/ 子目录）
```

## 目录桶与落盘分层

| 目录桶 | 物理路径 | 主要内容 | 主要写入入口 | 说明 |
|---|---|---|---|---|
| `sandbox` | `./data/sessions/<session_id>/sandbox/` | `execute_code` 内部代码写入文件 | `tools/local/code_sandbox.py` | 沙箱专用写入区；代码执行相对写路径默认落这里 |
| `transient` | `./data/sessions/<session_id>/transient/` | 临时中间数据、observation 大结果物化文件 | `tools.local.document_tools.write_file`（默认输出）、`ArtifactStore.save_text/save_json` | 属于临时文件区，不等于最终交付 |
| `workspace` | 默认 `./data/sessions/<session_id>/workspace/`；若 session.metadata.workspace_root 已配置，则指向该外部绝对目录 | 更稳定的工作文件 | `write_file` + `default_output_space=workspace` | 仅 workspace 工具语义可切到会话级外部目录；uploads 等其他桶不受影响 |
| `exports` | `./data/sessions/<session_id>/exports/<run_id>/` 或 `./data/sessions/<session_id>/exports/` | 明确导出/交付文件 | `write_file` + `default_output_space=exports` | 面向下载或最终交付 |
| `visualizations` | `./data/sessions/<session_id>/visualizations/` | 图表、地图、fallback PNG、viz 索引 | `VisualizationArtifactManager`、`visualization_fallback.py` | 可视化专用桶，artifact 主目录 |
| `uploads` | `./data/sessions/<session_id>/uploads/` | 用户上传文件 | `api/v1/files.py` | 上传 API 专用目录 |
| `monitoring/session_traces` | `./data/monitoring/session_traces/<session_id>/runs/<run_id>/` | 调试消息、运行步骤 JSONL | `execution/persistence/session_trace_writer.py` | 运行跟踪/调试数据，不属于业务文件 |
| `db` | `./data/db/` | SQLite 数据库等系统持久化文件 | `ConversationStore`、checkpoint 等 | 系统级持久化，不按 session 分桶 |
| `anonymous fallback` | `./data/sessions/anonymous/...` | 无 session 时的兜底文件 | 多处 fallback | 这是当前保留的系统策略 |

## 请求数据流

```
POST /api/agent/stream {task, session_id, selected_llm}
  → api/v1/stream.py
  → AgentExecutionAdapter.start_stream_execution()
  → AgentExecutionService.invoke_agent(mode=root)
  → AgentOrchestrator.route_task()
  → OrchestratorAgent.execute()
  → _execute_react_task() 主循环
      ├─ context_pipeline.prepare_messages()  # 构建提示词+历史
      │   └─ _apply_prompt_cache_policy()     # 仅标注稳定前缀缓存策略
      ├─ StreamExecutor.execute_llm_stream()  # LLM 流式调用
      │   ├─ ModelAdapter.chat_completion_stream()
      │   ├─ provider-specific request build   # OpenAI/Anthropic 在 provider 边界适配缓存协议
      │   ├─ StreamingXMLParser 增量解析 <intent>/<tools>/<final_answer>
      │   └─ tool_xml_parser.parse_tools_xml() 解析工具参数
      ├─ _handle_actions()                    # 执行工具/委派 Agent
      │   ├─ 占位符替换 {result_N.content.xxx}
      │   └─ route_direct_tool()       → execute_tool()
      └─ _handle_final_answer()               # 返回最终答案
  → SSEAdapter 转发事件 → 前端
```

## Agent 体系

### BaseAgent（agents/core/base.py）

所有 Agent 的抽象基类，核心方法：

| 方法 | 说明 |
|------|------|
| `execute(task, context) → AgentResponse` | 抽象方法，子类必须实现 |
| `can_handle(task, context) → bool` | 判断能否处理任务 |
| `_execute_react_task()` | ReAct 主循环（思考→工具→观察） |
| `_handle_actions()` | 执行工具调用，处理占位符替换 |
| `_resolve_tool_references()` | 解析 `{result_N.path}` 占位符 |
| `_build_system_prompt()` | 子类兼容入口，内部统一走共享 prompt skeleton |
| `_build_shared_system_prompt()` | 共享提示词骨架：intro / goal / principles / tools / skills / output / rules |
| `_build_direct_tools_section()` | 统一渲染 direct 工具条目、调用能力、参数、returns / usage_contract / examples |
| `_setup_react_runtime()` | 初始化上下文管道、观察策略等 |

关键属性：`name`, `description`, `available_tools`, `available_skills`, `max_rounds`, `model_adapter`, `agent_config`, `_publisher`

提示词职责分层：
- `BaseAgent`：统一维护工具契约渲染、调用能力标签、managed space 说明、输出格式和通用规则，并按工具能力条件注入 `execute_code` / `call_tool()` / 沙箱文件访问规则
- `Skills`：具体的 Skill 使用流程、脚本选择、参数约定、领域工作流由各自的 `SKILL.md` 定义
- `OrchestratorAgent`：已收敛为统一的通用 ReAct Agent 实现；主编排器模式下追加 `call_agent` 契约和 `delegation.enabled_agents` 驱动的动态 agent roster，普通 worker 模式下不暴露委派 roster
- `ToolRegistry` 是运行时唯一读模型：统一提供 direct / document / skill / builtin / agent / mcp 工具视图
- 工具系统已完成分层收敛：`tools/contracts` 负责纯模型，`tools/runtime` 负责 discovery / execute 主链，`tools/local` 承载工具实现，`tools/refs` / `tools/artifacts` / `tools/paths` 分别承载结果引用、artifact、路径子域；MCP 额外采用“外部展开、内部单网关”——Agent 继续看到 `mcp__<server>__<tool>`，运行时命名解析、执行入口与 observability 透传统一收敛到 `tools.runtime.mcp_gateway`

### MCP 运行时收口

MCP 暴露模型保持不变：`AgentLoader._resolve_tools_and_skills()` 仍通过 `mcp.client_manager.MCPClientManager.get_tools_openai_format()` 为启用的 server 注入展开后的 `mcp__<server>__<tool>` 工具定义，因此 prompt contract、LLM 可见工具面与现有测试语义都不变。

变化仅发生在内部运行时：

- `tools/catalog/mcp_tools.py` 只负责 schema / contract 适配
- `tools/runtime/mcp_gateway.py` 统一负责 MCP 工具名识别、解析与执行
- `tools/runtime/dispatcher.py` 对 MCP 只做薄封装转调 gateway
- `tools/permissions.py` 继续保留授权策略，但 server/tool 解析统一复用 gateway
- `services/mcp_service.py` 继续作为真实业务调用入口

这样 MCP 在工程结构上更接近 `call_agent`：外部仍是展开工具，内部则由单一运行时入口承接执行语义。

### OrchestratorAgent（agents/implementations/orchestrator/）

统一的通用 ReAct Agent 实现。主编排器模式下，可通过 `call_agent(agent_name, task, context_hint)` 创建新的子 Agent 会话，并通过 `send_message(child_agent_id, message)` 续接既有子 Agent；普通 worker 模式下则只保留工具调用能力，不暴露 agent roster。

| 文件 | 职责 |
|------|------|
| `agent.py` | OrchestratorAgent 类：统一承载主编排器与 worker 两种模式，复用 BaseAgent 共享 skeleton 构造 prompt |
| `prompting.py` | `call_agent` 委派提示段、allowlist agent roster 注入、`replace_placeholders()`；当 agent 无 orchestrator 引用时自动降级为空 roster |
| `tool_router.py` | 统一 direct 工具路由到 dispatcher（含 builtin/agent 工具） |
| `runtime.py` | 运行时入口（当前仅薄封装到 `_execute_react_task()`） |
| `services/agent_execution_service.py` | 统一 agent 执行入口，承接 `/execute`、`/collaborate`、user->agent 与子 Agent turn，并在内部通过 `mode=root|child` 与 `child_agent_id -> thread_key` 收口 root/child 上下文；`/collaborate` 额外通过 route_task 先解析目标 Agent，再复用 `invoke_agent(mode=root)` |


### 已配置的 Agent（agent_configs.yaml）

| Agent | 类型 | 模型 | 用途 |
|-------|------|------|------|
| orchestrator_agent | Orchestrator | gpt-5.4 | 主编排器（默认入口） |
| emergency_agent | Orchestrator | gpt-5.4 | 应急决策 |
| chart_agent | Orchestrator | gpt-5.4 | 可视化 |
| kgqa_agent | Orchestrator | gpt-5.4 | 知识图谱问答 |
| flood_extraction_agent | Orchestrator | deepseek-chat | 洪涝数据提取 |

Agent 类型由 `AgentLoader._get_agent_type()` 解析，兼容两种写法：
- `custom_params.type`（优先）
- `custom_params.behavior.type`（兼容当前 YAML 结构）

`application/agent_collaboration.py` 中的回退重试也已不再直调 `orchestrator.execute()`：其中 `rollback_and_retry()` 直接复用 `AgentExecutionService.invoke_routed_agent()`；`recover_session()` 因需要先把 checkpoint messages 重放进临时 context，仍保留“checkpoint 注入上下文 + routed agent.execute(context)”的执行形态，但目标 Agent 的选择也已统一复用 execution service 的路由解析。

## 占位符系统

两层占位符替换，均在工具执行前完成：

| 层级 | 实现位置 | 作用域 |
|------|---------|--------|
| Agent 层 | `orchestrator/prompting.py` → `replace_placeholders()` | 同轮多个 Agent 调用之间 |
| 工具层 | `BaseAgent._handle_actions()` + 可选 `_resolve_tool_references()` 扩展点 | 同轮多个工具调用之间 |

支持格式：`{result_1}`, `{result_1.content.layers}`, `{RESULT_1.RISK_LEVEL}`（大小写不敏感，提示词示例统一使用单花括号 `{result_N}`）

核心解析：`tools/refs/result_references.py` → `resolve_result_path()`, `materialize_result_reference()`

路径解析加固：解析失败时返回错误标记（`make_ref_error()`），Agent 在 observation 中看到 `[引用错误: 路径 "xxx" 不存在, 可用: [...]]`，可感知并重试。

未替换占位符拦截：`base.py._handle_actions` 在工具执行前调用 `detect_unresolved_placeholders()` 检测残留占位符，命中则跳过执行并返回错误提示。

### 文件类 document 工具路径治理

文件类 document 工具（read_file, edit_file, write_file, preview_data_structure）已迁移为 `tools.local.document_tools` 内的 `@tool(source="document")` 工具，和其他 direct 工具一样经自动发现注册进入统一 `TOOL_HANDLERS`；`execute_bash` 则在 `tools.local.bash_tool` 内部独立完成工作目录解析：

```
占位符替换 → 统一 tool handler 分发 → local.document_tools._prepare_document_tool_args / local.bash_tool._resolve_work_dir → tool 执行 → resource scope 推断/清理
```

- 路径解析统一由 `tools/paths/path_resolution.py` 提供：文件走 `resolve_managed_path()`，目录走 `resolve_managed_directory()`，并按 caller / operation 选择受管边界
- XML 工具参数里的 `<file_path space="workspace|transient|exports">...</file_path>` 与 `<working_dir space="workspace|transient|exports">...</working_dir>` 会在 `tool_xml_parser.py` 中分别扁平化为 `file_path + file_path_space`、`working_dir + working_dir_space`
- ToolContract 示例渲染时，若要展示 XML 属性（如 `space="transient"`），需通过示例元数据 `xml_attrs` 渲染到标签属性；不要把 `<file_path ...>...</file_path>` / `<working_dir ...>...</working_dir>` 当作 JSON 字符串参数示例
- `file_path@space` 与 `working_dir@space` 属于同一套 managed location language：`workspace` 指向当前 effective workspace，`transient` 指向当前 session 的 transient 目录，`exports` 指向当前 session 的 exports/<run_id>
- `space` 仅影响相对路径 / 相对目录；绝对路径仍只做受管边界校验，不会被 `space` 改写
- direct 文件工具的相对 `file_path` 默认按 workspace 解析；`execute_bash` 的相对 `working_dir` 默认也按 workspace 解析，不再默认落到 `backend-fastapi/`
- `workspace` 的默认物理目录仍是 `./data/sessions/<session_id>/workspace/`；若会话在创建时通过 `POST /api/agent/sessions` 传入 `metadata.workspace_root`，则 direct 文件工具、`execute_code` 与 `execute_bash` 在执行期统一切换到该 external workspace
- `AgentApiRuntimeService.build_context()` 会读取 `session.metadata.workspace_root` 并写入本次运行上下文；`create_execution_orchestrator(session_id=...)` 会为本次执行复制 agent_config 并注入 `custom_params.workspace_root`，避免污染全局 YAML / 其他会话
- `tools.local.document_tools._prepare_document_tool_args()` 会直接从 `agent_config.custom_params` 读取 `workspace_root/default_output_space`，并按“显式 run_id 优先，observability fallback”解析 `effective_run_id`
- `write_file` 未指定路径时由 `resolve_managed_path(..., operation='write')` 按 `default_output_space` 分配受管路径（exports/workspace/transient），其中 `default_output_space=workspace` 会落到当前 effective workspace，而不是固定写死到 session/workspace
- `read_file` / `write_file` / `edit_file` 仅允许 `direct` 调用，不再对 `caller=code_execution` 开放；`preview_data_structure` 仍允许 `code_execution`
- `read_file` 仍保留大文件确认、分页与 direct 调用语义
- sandbox（`tools/local/code_sandbox.py`）保留独立的运行时文件边界：代码中直接使用受限 `open()` 读取文件、先 `request_write_approval()` 再 `open()` 写文件，底层同样通过 `resolve_managed_path(..., caller='code_execution')` 落到当前 session 的受管目录；其中 `SESSION_WORKSPACE_DIR` / `DATA_DIR` 也会指向同一个 effective workspace
- `execute_bash` 不接入 document 特殊链；它通过 dispatcher 自动注入的 `session_id`、`agent_config.custom_params.workspace_root` 以及 `get_current_execution_observability_fields().run_id` 在工具内部完成统一路径语义解析
- 默认受管目录根的自动补建统一下沉到 `tools/paths/path_resolution.py`：当 direct 工具以目录根语义访问 `workspace/transient/exports`（如 `working_dir` 省略、为空或为 `.`）且目标根目录尚未创建时，共享路径层会先补建对应根目录，再返回解析结果；这样 `execute_bash` 不需要单独维护目录创建分支
- `execute_bash` 在工具内部额外维护一条 bash 专用审批链：白名单命令直接执行，所有非白名单命令统一触发 `user.approval_required`；其中删除、远程下载、解释器 / 子 shell、进程控制、系统控制等高风险命令会在审批 payload 中额外标记并提升风险提示，但不再硬拒绝
- `execute_code` 现已改为“主进程协调 + 沙箱子进程执行”模型：主进程负责静态检查、路径解析、审批等待、工具分发与超时/取消回收，子进程只负责受限 `exec()`；超时和 cancel 会直接终止子进程，因此不再依赖线程内逻辑超时
- dispatcher 对 `execute_code` 做特殊收口：不再走通用 `_run_with_timeout()` 线程包装，而是把 `cancel_event` 直接注入 `tools.local.code_sandbox`，由沙箱内部统一管理 timeout / cancel 语义
- 因此，direct 文件工具路径治理、bash 工作目录解析与沙箱文件访问是三条职责分离但共享同一受管路径语言的链路

XML 解析层修复：`streaming/tool_xml_parser.py` → `_fix_bare_placeholders()` 处理裸占位符

## 流式输出与事件系统

### XML 协议格式

```xml
<intent>思考过程</intent>
<tools>
  <tool name="tool_name">
    <param>value</param>
    <code><![CDATA[多行代码或含 < > & 的内容]]></code>
  </tool>
</tools>
<final_answer>最终答案，可含 [viz:artifact_id] 占位符</final_answer>
```

参数传递采用 XML 子标签格式（推荐），JSON 格式作为兼容 fallback 仍可使用：
- XML 子标签：`<param>value</param>`，多行/特殊字符用 CDATA 包裹
- JSON（兼容）：`<tool name="xxx">{"param": "value"}</tool>`
- 类型推断：`"true"`/`"false"` → bool，纯数字 → int/float，`[...]`/`{...}` → JSON 解析

### 事件类型（EventType 枚举）

事件规范：**一个语义只对应一个事件名**。编排器根节点只发 `run.start/end` 与 `call.agent.start/end`，不再重复发 `agent.start/end`。

其中 `run.start/end` 已从 `OrchestratorAgent` 解耦，统一由 `BaseAgent` 在 ReAct 主循环入口/清理阶段发布；因此所有 Agent 类型在顶层执行时都具备一致的 run 生命周期语义。

| 类别 | 事件 |
|------|------|
| Agent 生命周期 | AGENT_START, AGENT_END, AGENT_ERROR |
| 意图流 | INTENT_DELTA, INTENT_COMPLETE, REACT_INTERMEDIATE |
| 调用生命周期 | CALL_AGENT_START/END, CALL_TOOL_START/END |
| 流式输出 | CHUNK, FINAL_ANSWER, MESSAGE_SAVED |
| 用户交互 | USER_APPROVAL_REQUIRED, USER_INPUT_REQUIRED, USER_INTERRUPT |
| 上下文 | COMPRESSION_SUMMARY, CONTEXT_USAGE |
| 系统 | RUN_START, RUN_END, SESSION_END, ERROR |

`USER_APPROVAL_REQUIRED` 当前承载多类审批场景：
- dispatcher 基于 `ToolPermission.requires_approval` 的通用工具审批
- `execute_code` / 沙箱内的模块导入、文件写入等审批
- `read_file` 大文件完整读取确认
- `execute_bash` 对所有非白名单命令的临时放行审批（payload 中 `approval_type=bash_command`，并携带原始 command、命中的非白名单分段、解析后的 working_dir）；若命中高风险命令，还会额外携带 `dangerous_command_segments` 并提升审批文案风险级别

说明：
- `INTENT` / `INTENT_STRUCTURED` 已删除，不再使用。
- `REACT_INTERMEDIATE` 仍保留，用于 messages 持久化与上下文重建，不再承担前端执行树去重职责。
- `CHART_GENERATED` / `MAP_GENERATED` 为兼容旧 DB 记录保留。

### 统一 execution step sidecar

系统保持 **message-first** 主模型：`messages` 仍是会话主对象，`run_steps` / `execution_steps` 只是 assistant message / run 的执行轨迹 sidecar，通过 `(session_id, run_id)` 持久化并最终关联到 assistant `message_id`。

在同一 `session_id` 下，消息与 run 的 child 历史由 `child_agent_id` 表达：
- 顶层入口固定使用 `thread_key=root`
- 子 Agent 对外以 `child_agent_id` 续接，不再暴露 `thread_key`
- 运行时内部约定 `thread_key = child:{child_agent_id}`
- child 会话创建检查点直接记录在 `child_agents.created_seq`，不再通过 `child_agent_anchor` 空消息占位
- `child_agent_id` 是稳定子会话 ID；`call_id` 仍表示一次调用节点；`run_id` 仍表示一次执行实例
- `child_agents.created_seq` 记录该 child 会话在主 session 消息流中的创建检查点；rollback 时若 `created_seq > after_seq`，则该 child 会话会随 checkpoint 一并移除
- `AgentSessionApplication.list_messages()` 默认仍只展示 root 主消息流；会过滤 `react_intermediate`、`visible_to_user=False`、`conversation_scope='child'` 与非 `root` 线程消息；child 对话主要用于上下文恢复与调试

统一执行树的唯一事实源是 **canonical `execution.step`**：

- 原始 EventBus 事件只作为运行时内部事件
- `execution/step_projector.py` 监听原始事件并投影出 `execution.step`
- `run_steps.step_type` 固定存 `execution.step`
- `run_steps.payload` 只持久化 canonical step 的精简字段集合：保留 UI 所需的结构/状态/展示字段；`intent delta` / `round update` 这类纯流式碎片不入库；`event_id`、`timestamp`、`source_event_type`、`node_id`、`parent_node_id`、`child_agent_id`、`mode`、`raw_result_ref`、`resource_refs` 等调试/冗余字段不写入 payload
- `application/agent_session.py:list_messages()` 返回进一步裁剪后的 `execution_steps`：继续保留前端现阶段渲染所需字段，但不暴露 `raw_result`、`raw_result_ref`、`resource_refs` 和调试追踪字段
- reconnect 回放 EventBus 历史时，前端看到的执行树事件也只有 `execution.step`

canonical step 当前覆盖的语义：

- `kind=run`, `phase=start|end`
- `kind=subtask`, `phase=start|end`
- `kind=intent`, `phase=complete`（`phase=delta` 仅用于 SSE 流式展示，不持久化到 `run_steps`）
- `kind=tool`, `phase=start|end`
- `kind=visualization`, `phase=complete`

典型字段：

- 结构字段：`node_id`, `parent_node_id`, `call_id`, `parent_call_id`, `child_agent_id`
- 展示字段：`agent_name`, `agent_display_name`, `tool_name`, `description`, `content`
- 状态字段：`round`, `status`, `elapsed_time`
- 结果字段：`result`, `result_preview`, `raw_result`, `raw_result_ref`, `raw_result_available`
- 追踪字段：`source_event_type`, `event_id`, `timestamp`, `_execution`

不纳入 execution step 的内容：

- 根智能体 `output.chunk`
- 根智能体 `output.final_answer`
- `output.message_saved`
- approval / user input / heartbeat / reconnect / done 等控制流

### Execution step 发布与持久化链路

```text
原始 EventBus 事件
  ├─ StepProjector → execution.step
  ├─ SSEAdapter → 纯转发 execution.step 与消息流事件
  ├─ RunStepPersistenceHandler → run_steps（直接存 canonical execution.step）
  └─ MessagePersistenceHandler → messages（仅 user / root assistant final answer / compression）
```

关键边界：

- `execution/step_projector.py` 是 raw event → canonical step 的唯一投影层
- `agents/core/base.py` 中的 tool start/end 事件统一直接走 `EventPublisher` 主链，避免 round / parent_call_id 等字段在兼容分支中丢失
- `agents/events/sse_adapter.py` 不再承担执行树语义映射，只负责转发事件
- `api/v1/stream.py` reconnect 回放的是同一条 EventBus 历史，因此实时与重连都会收到相同的 `execution.step`
- 子 Agent 递归显示依赖同一棵 root execution tree：`call_agent` / `send_message` 创建的可见 subtask 节点 `call_id`，必须继续透传到子 Agent 执行上下文 `context.metadata.call_id`；这样 child agent 内部的 `intent/tool` 才会以同一 `call_id` 继续发事件，并递归挂入该 subtask，而不是生成新的孤立调用节点
- `execution/runstep_normalizer.py` 已删除，不再存在 raw run_steps → normalized steps 的兼容层
- `services/conversation_store.py:get_tool_call_raw_result()` 从 canonical `execution.step(kind=tool, phase=end)` 中读取工具原始结果
- `execution/persistence/message_handler.py` 现支持 root / child 两类消息持久化边界，通过 `child_agent_id + thread_key + visible_to_user` 控制恢复与展示语义
- 贴近 Claude Code 语义：主会话回退默认不自动回退已创建的 child agent；若后续需要级联回退，必须显式实现 child 会话失效逻辑

### 事件流转

```
EventBus (agents/events/bus.py)
  ↓ publish()
EventPublisher (agents/events/publisher.py)  ← Agent 使用的简化 API
  ↓
SSEAdapter (agents/events/sse_adapter.py)    ← 桥接到前端 SSE（有界队列 + 背压保护）
  ↓
api/v1/stream.py                             ← HTTP SSE 端点
```

Event 携带全局递增 `sequence_number`（`seq` 字段），前端可检测事件 gap。

关键事件类型（`CRITICAL_EVENT_TYPES`）在队列满时不会被丢弃：RUN_START/END, AGENT_START/END/ERROR, SESSION_END, USER_INTERRUPT, FINAL_ANSWER, MESSAGE_SAVED, USER_APPROVAL_REQUIRED, USER_INPUT_REQUIRED。

SSEAdapter 背压策略：有界队列（默认 100），非关键事件队满时丢弃，关键事件队满时驱逐非关键事件腾出空间。心跳携带 `last_seq` 和 `dropped_count`。

## 上下文管理

| 组件 | 文件 | 职责 |
|------|------|------|
| ContextPipeline | `agents/context/pipeline.py` | 消息准备、压缩触发、稳定前缀缓存标注 |
| PromptMaterializer | `agents/context/prompt_materializer.py` | 提示词物化 |
| TokenCounter | `agents/context/token_counter.py` | Token 计数（支持 string / content blocks） |
| ObservationPolicy | `agents/context/observation_policy.py` | 工具结果内联/落盘策略 |
| CompressionView | `agents/context/compression_view.py` | 上下文压缩 |
| 观察格式化器 | `agents/context/observation_formatters/` | chart/map/json/text/skills 等 |

压缩触发：上下文用量达到 `compression_trigger_ratio`（默认 0.8）时自动摘要早期轮次。

Prompt cache 策略：`ContextPipeline.prepare_messages()` 在不改变 BaseAgent 主循环的前提下，只对稳定前缀做最小标注。默认优先缓存 system prompt、压缩摘要、以及早于当前轮的稳定历史前缀；不会缓存当前用户输入、当前轮 assistant 输出或 observation。Anthropic 的 content blocks / `cache_control` 转换延迟到 provider 边界执行，避免污染通用消息结构。

压缩降级策略：当 LLM 摘要失败（`ContextCompressionError`）时，自动降级为截断模式——丢弃最早的消息，保留最近 `preserve_recent_turns` 轮，插入 `[历史摘要]\n（LLM 摘要不可用，已丢弃 N 条消息）` 标记。降级不会终止 ReAct 循环，确保对话可以继续。

## 配置系统

| 配置文件 | 职责 | 热加载 |
|---------|------|--------|
| `agents/configs/agent_configs.yaml` | Agent 定义（LLM、工具、Skills、MCP） | 支持 |
| `model_adapter/configs/providers.yaml` | LLM Provider（API key、模型列表） | 支持 |
| `mcp/configs/mcp_servers.yaml` | MCP 服务器连接 | 支持 |
| `config/yaml/config.yaml` | 系统级（向量库、embedding） | 否 |

- `agents/configs/agent_configs.yaml` 现包含四类显式能力配置域：`tools.enabled_tools`（direct 本地工具）、`skills.enabled_skills`、`mcp.enabled_servers`、`delegation.enabled_agents`
- `call_agent` 不属于 `tools.enabled_tools` 域，而由 `delegation.enabled_agents` 是否非空决定是否注入

- `model_adapter/base.py` 中的 `AIProvider` 暴露统一能力声明：`supports_prompt_caching`、`prompt_cache_style`、`prompt_cache_min_tokens`
- 当前已接入原生缓存语义的 provider：
  - `openai`：保持 chat.completions 调用模式，依赖 OpenAI 服务端自动缓存，并从 `usage.prompt_tokens_details.cached_tokens` 提取 `cached_tokens`
  - `anthropic`：新增原生 `AnthropicProvider`，在 provider 边界把通用消息转换为 content blocks，并在稳定前缀断点追加 `cache_control`
- `deepseek` / `openrouter` / `modelscope` 当前保持 capability-aware 直通，不强行注入缓存协议
- `AgentLLMConfig.prompt_cache_enabled` 可显式开关缓存；默认 `None` 表示跟随 provider 默认能力
- `ModelResponse.usage` 扩展缓存指标：
  - OpenAI：`cached_tokens`
  - Anthropic：`cache_creation_input_tokens`、`cache_read_input_tokens`

## Skills 系统

渐进式加载：`activate_skill()` → `load_skill_resource()` → `execute_skill_script()`

Skill 系统工具（activate_skill、load_skill_resource、execute_skill_script、get_skill_info）通过 `@tool(source="skill")` 注册。`ToolRegistry.get_skill_tools()` 动态过滤 `source="skill"` 的工具定义。当 Agent 配置了 `skills.auto_inject: true` 时，`AgentLoader._resolve_tools_and_skills()` 自动将这些工具注入到 Agent 的 `available_tools` 中。

| Skill | 路径 | 关键脚本 |
|-------|------|---------|
| guangxi-geodata | `agents/skills/guangxi-geodata/` | geocode.py, query_features.py, fetch_weather.py |
| guangxi-flood-data | `agents/skills/guangxi-flood-data/` | fetch_weather.py, fetch_hydrology.py |
| guangxi-hydrology-web | `agents/skills/guangxi-hydrology-web/` | fetch_rain.py, fetch_river.py |
| gis-bindmap | `agents/skills/gis-bindmap/` | spatial_bindmap.py, distance_matrix.py, basin_bindmap.py |
| geojson-analysis | `agents/skills/geojson-analysis/` | geojson_filter.py, geojson_spatial.py, geojson_stats.py |
| kg-advanced-query | `agents/skills/kg-advanced-query/` | query.py, entity_detail.py, geo_export.py 等 |
| emergency-decision-support | `agents/skills/emergency-decision-support/` | assess_flood_risk.py, plan_recommend.py 等 |

## API 路由

| 前缀 | 文件 | 职责 |
|------|------|------|
| `/api/agent/stream` | `api/v1/stream.py` | SSE 流式执行 |
| `/api/agent/sessions` | `api/v1/sessions.py` | 会话管理 |
| `/api/agent-config` | `api/v1/config.py` | Agent 配置 CRUD |
| `/api/model-adapter` | `api/v1/models.py` | LLM Provider 管理 |
| `/api/mcp` | `api/v1/mcp.py` | MCP 服务器管理 |
| `/api/files` | `api/v1/files.py` | 文件上传 |
| `/api/artifacts` | `api/v1/artifacts.py` | 可视化 artifact |
| `/api/vector-library` | `api/v1/vector.py` | 向量库查询 |
| `/api/monitoring` | `api/v1/monitoring.py` | 监控与诊断 |

## 新增 Agent 步骤

1. `agents/implementations/<name>/agent.py` — 继承 BaseAgent，实现 `execute()` + `can_handle()`
2. `agents/core/registry.py` — 注册
3. `agents/configs/agent_configs.yaml` — 添加配置
4. 更新本文档

## 新增 LLM Provider 步骤

1. `integrations/model_providers/` — 创建 Provider 类
2. `model_adapter/configs/providers.yaml` — 添加配置
3. 更新本文档

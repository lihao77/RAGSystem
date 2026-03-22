# 后端架构总览

> 变更代码后请同步更新本文档。

## 目录结构

```
backend-fastapi/
├── agents/                    # 智能体系统
│   ├── core/                  # 基础设施（BaseAgent, Context, Orchestrator, Registry）
│   ├── implementations/       # Agent 实现
│   │   ├── orchestrator/      # OrchestratorAgent（主编排器）
│   │   └── react/             # ReActAgent（通用工具调用 Agent）
│   ├── config/                # AgentConfig 配置加载
│   ├── context/               # 上下文管道、压缩、观察格式化
│   ├── events/                # EventBus、EventPublisher、SSEAdapter
│   ├── streaming/             # XML 流式解析（StreamingXMLParser, tool_xml_parser）
│   ├── skills/                # Skills 目录（每个 Skill 一个子目录）
│   ├── monitoring/            # 指标收集、观察窗口
│   ├── recovery/              # 检查点恢复
│   └── tests/                 # pytest 测试
├── tools/                     # 工具系统（详见 tools.md）
│   └── path_resolution.py     # 全局路径管理中心
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
    ├── db/                    # 数据库文件（vector_store.db, ragsystem.db, checkpoints.db）
    ├── artifacts/             # 工具产出的持久化文件
    │   └── visualizations/    # 可视化 JSON
    ├── transient/             # 临时文件（可定期清理）
    │   ├── code_execution/    # 代码沙箱产出（按 session 隔离）
    │   └── scratch/           # 其他临时文件
    ├── exports/               # 供用户下载的文件（按 session/run 组织）
    ├── workspace/             # 用户工作空间（按 session 隔离，预留）
    ├── monitoring/            # 监控数据（指标、观察窗口、session 追踪）
    └── backups/               # 数据库备份（由备份工具按需创建）
```

## 目录桶与落盘分层

| 目录桶 | 物理路径 | 主要内容 | 主要写入入口 | 说明 |
|---|---|---|---|---|
| `sandbox` | `./data/sessions/<session_id>/sandbox/` | `execute_code` 内部代码写入文件 | `tools/code_sandbox.py` | 沙箱专用写入区；代码执行相对写路径默认落这里 |
| `transient` | `./data/sessions/<session_id>/transient/` | 临时中间数据、observation 大结果物化文件 | `document_executor.write_file`（默认输出）、`ArtifactStore.save_text/save_json` | 属于临时文件区，不等于最终交付 |
| `workspace` | `./data/sessions/<session_id>/workspace/` | 更稳定的工作文件 | `write_file` + `default_output_space=workspace` | 给 agent/tool 持续编辑、复用 |
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
  → RuntimeContainer.get_orchestrator()
  → AgentOrchestrator.route_task()
  → OrchestratorAgent.execute()
  → _execute_react_task() 主循环
      ├─ context_pipeline.prepare_messages()  # 构建提示词+历史
      ├─ StreamExecutor.execute_llm_stream()  # LLM 流式调用
      │   ├─ StreamingXMLParser 增量解析 <intent>/<tools>/<final_answer>
      │   └─ tool_xml_parser.parse_tools_xml() 解析工具参数
      ├─ _handle_actions()                    # 执行工具/委派 Agent
      │   ├─ 占位符替换 {result_N.content.xxx}
      │   ├─ route_agent_delegation()  → AgentExecutor
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
| `_build_system_prompt()` | 构建系统提示词 |
| `_setup_react_runtime()` | 初始化上下文管道、观察策略等 |

关键属性：`name`, `description`, `available_tools`, `available_skills`, `max_rounds`, `model_adapter`, `agent_config`, `_publisher`

### OrchestratorAgent（agents/implementations/orchestrator/）

主编排器，将其他 Agent 作为工具调用（`invoke_agent_<name>`）。

| 文件 | 职责 |
|------|------|
| `agent.py` | OrchestratorAgent 类，复用 ReAct 主循环 |
| `executor.py` | AgentExecutor，执行子 Agent 调用 |
| `prompting.py` | 提示构建 + `replace_placeholders()` 占位符替换 |
| `tool_router.py` | 三层路由：user_input → Agent 委派 → 直接工具 |
| `runtime.py` | 运行时入口 |

### ReActAgent（agents/implementations/react/agent.py）

通用 ReAct 智能体，支持工具调用和 Skills。`_resolve_tool_references()` 处理同轮工具链式引用。

### 已配置的 Agent（agent_configs.yaml）

| Agent | 类型 | 模型 | 用途 |
|-------|------|------|------|
| orchestrator_agent | Orchestrator | gpt-5.4 | 主编排器（默认入口） |
| emergency_agent | ReAct | gpt-5.4 | 应急决策 |
| chart_agent | ReAct | gpt-5.4 | 可视化 |
| kgqa_agent | ReAct | gpt-5.4 | 知识图谱问答 |
| flood_extraction_agent | ReAct | deepseek-chat | 洪涝数据提取 |

Agent 类型由 `AgentLoader._get_agent_type()` 解析，兼容两种写法：
- `custom_params.type`（优先）
- `custom_params.behavior.type`（兼容当前 YAML 结构）

## 占位符系统

两层占位符替换，均在工具执行前完成：

| 层级 | 实现位置 | 作用域 |
|------|---------|--------|
| Agent 层 | `orchestrator/prompting.py` → `replace_placeholders()` | 同轮多个 Agent 调用之间 |
| 工具层 | `react/agent.py` → `_resolve_tool_references()` | 同轮多个工具调用之间 |

支持格式：`{result_1}`, `{result_1.content.layers}`, `{RESULT_1.RISK_LEVEL}`（大小写不敏感）

核心解析：`tools/result_references.py` → `resolve_result_path()`, `materialize_result_reference()`

路径解析加固：解析失败时返回错误标记（`make_ref_error()`），Agent 在 observation 中看到 `[引用错误: 路径 "xxx" 不存在, 可用: [...]]`，可感知并重试。

未替换占位符拦截：`base.py._handle_actions` 在工具执行前调用 `detect_unresolved_placeholders()` 检测残留占位符，命中则跳过执行并返回错误提示。

### 文档工具路径预处理

文档工具（read_document, read_file, edit_file, write_file, preview_data_structure）在进入 tool 实现前，由 `dispatcher._preprocess_document_tool_args()` 统一做路径归一化：

```
占位符替换 → 路径预处理 → tool 执行 → resource scope 推断/清理
```

- 路径解析统一由 `tools/path_resolution.py` 的 `resolve_managed_path()` 完成，并按 caller / operation 选择受管边界
- `write_file` 未指定路径时由 `resolve_managed_path(..., operation='write')` 按 `default_output_space` 分配受管路径（exports/workspace/transient），不再落到系统 temp
- direct 文档工具链会在进入 `document_executor.py` 前完成路径预处理；开发期已移除对历史旧目录的读取兼容，tool 实现层只接受当前受管目录内的绝对路径
- 文档工具里的 `read_file` / `write_file` / `edit_file` 现在仅允许 `direct` 调用，不再对 `caller=code_execution` 开放
- sandbox（`code_sandbox.py`）保留独立的运行时文件边界：代码中直接使用受限 `open()` 读取文件、先 `request_write_approval()` 再 `open()` 写文件，底层同样通过 `resolve_managed_path(..., caller='code_execution')` 落到当前 session 的受管目录
- `execute_code` 现已改为“主进程协调 + 沙箱子进程执行”模型：主进程负责静态检查、路径解析、审批等待、工具分发与超时/取消回收，子进程只负责受限 `exec()`；超时和 cancel 会直接终止子进程，因此不再依赖线程内逻辑超时
- dispatcher 对 `execute_code` 做特殊收口：不再走通用 `_run_with_timeout()` 线程包装，而是把 `cancel_event` 直接注入 `code_sandbox.py`，由沙箱内部统一管理 timeout / cancel 语义
- 因此，文档工具路径预处理与沙箱文件访问是两条职责分离的路径：前者服务 agent direct 文件工具，后者服务 execute_code 内部文件操作

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

| 类别 | 事件 |
|------|------|
| Agent 生命周期 | AGENT_START, AGENT_END, AGENT_ERROR |
| 意图流 | INTENT_DELTA, INTENT_COMPLETE, REACT_INTERMEDIATE |
| 调用生命周期 | CALL_AGENT_START/END, CALL_TOOL_START/END |
| 流式输出 | CHUNK, FINAL_ANSWER, MESSAGE_SAVED |
| 用户交互 | USER_APPROVAL_REQUIRED, USER_INPUT_REQUIRED, USER_INTERRUPT |
| 上下文 | COMPRESSION_SUMMARY, CONTEXT_USAGE |
| 系统 | RUN_START, RUN_END, SESSION_END, ERROR |

说明：
- `INTENT` / `INTENT_STRUCTURED` 已删除，不再使用。
- `REACT_INTERMEDIATE` 仍保留，用于 messages 持久化与上下文重建，不再承担前端执行树去重职责。
- `CHART_GENERATED` / `MAP_GENERATED` 为兼容旧 DB 记录保留。

### 统一 execution step sidecar

系统保持 **message-first** 主模型：`messages` 仍是会话主对象，`run_steps` / `execution_steps` 只是 assistant message / run 的执行轨迹 sidecar，通过 `(session_id, run_id)` 持久化并最终关联到 assistant `message_id`。

统一执行树的唯一事实源是 **canonical `execution.step`**：

- 原始 EventBus 事件只作为运行时内部事件
- `execution/step_projector.py` 监听原始事件并投影出 `execution.step`
- `run_steps.step_type` 固定存 `execution.step`
- `run_steps.payload` 直接存 canonical step data，不再存 raw event snapshot
- `application/agent_session.py:list_messages()` 直接返回持久化的 canonical `execution_steps`
- reconnect 回放 EventBus 历史时，前端看到的执行树事件也只有 `execution.step`

canonical step 当前覆盖的语义：

- `kind=run`, `phase=start|end`
- `kind=subtask`, `phase=start|end`
- `kind=intent`, `phase=delta|complete`
- `kind=tool`, `phase=start|end`
- `kind=visualization`, `phase=complete`

典型字段：

- 结构字段：`node_id`, `parent_node_id`, `call_id`, `parent_call_id`
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
- `agents/events/sse_adapter.py` 不再承担执行树语义映射，只负责转发事件
- `api/v1/stream.py` reconnect 回放的是同一条 EventBus 历史，因此实时与重连都会收到相同的 `execution.step`
- `application/agent_session.py:list_messages()` 与 `export_session()` 对 assistant message 直接返回持久化的 canonical `execution_steps`
- `execution/runstep_normalizer.py` 已删除，不再存在 raw run_steps → normalized steps 的兼容层
- `services/conversation_store.py:get_tool_call_raw_result()` 从 canonical `execution.step(kind=tool, phase=end)` 中读取工具原始结果

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
| ContextPipeline | `agents/context/pipeline.py` | 消息准备、压缩触发 |
| PromptMaterializer | `agents/context/prompt_materializer.py` | 提示词物化 |
| TokenCounter | `agents/context/token_counter.py` | Token 计数 |
| ObservationPolicy | `agents/context/observation_policy.py` | 工具结果内联/落盘策略 |
| CompressionView | `agents/context/compression_view.py` | 上下文压缩 |
| 观察格式化器 | `agents/context/observation_formatters/` | chart/map/json/text/skills 等 |

压缩触发：上下文用量达到 `compression_trigger_ratio`（默认 0.8）时自动摘要早期轮次。

压缩降级策略：当 LLM 摘要失败（`ContextCompressionError`）时，自动降级为截断模式——丢弃最早的消息，保留最近 `preserve_recent_turns` 轮，插入 `[历史摘要]\n（LLM 摘要不可用，已丢弃 N 条消息）` 标记。降级不会终止 ReAct 循环，确保对话可以继续。

## 配置系统

| 配置文件 | 职责 | 热加载 |
|---------|------|--------|
| `agents/configs/agent_configs.yaml` | Agent 定义（LLM、工具、Skills、MCP） | 支持 |
| `model_adapter/configs/providers.yaml` | LLM Provider（API key、模型列表） | 支持 |
| `mcp/configs/mcp_servers.yaml` | MCP 服务器连接 | 支持 |
| `config/yaml/config.yaml` | 系统级（向量库、embedding） | 否 |

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

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
├── api/v1/                    # FastAPI 路由层
├── runtime/                   # RuntimeContainer 中央容器
├── model_adapter/             # LLM Provider 统一适配
├── mcp/                       # MCP 协议支持
├── services/                  # 业务服务层
├── application/               # 应用层（会话、协作）
├── capabilities/              # 能力模块（文档检索、向量检索、MCP）
├── config/yaml/               # 系统级 YAML 配置
├── lifespan.py                # 启动生命周期
└── main.py                    # 应用入口
```

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

XML 解析层修复：`streaming/tool_xml_parser.py` → `_fix_bare_placeholders()` 处理裸占位符

## 流式输出与事件系统

### XML 协议格式

```xml
<intent>思考过程</intent>
<tools>
  <tool name="tool_name">{"param": "value"}</tool>
</tools>
<final_answer>最终答案，可含 [viz:artifact_id] 占位符</final_answer>
```

### 事件类型（EventType 枚举）

| 类别 | 事件 |
|------|------|
| Agent 生命周期 | AGENT_START, AGENT_END, AGENT_ERROR |
| 意图流 | INTENT_DELTA, INTENT_COMPLETE, REACT_INTERMEDIATE |
| 调用生命周期 | CALL_AGENT_START/END, CALL_TOOL_START/END |
| 流式输出 | CHUNK, FINAL_ANSWER, MESSAGE_SAVED |
| 用户交互 | USER_APPROVAL_REQUIRED, USER_INPUT_REQUIRED, USER_INTERRUPT |
| 上下文 | COMPRESSION_SUMMARY, CONTEXT_USAGE |
| 系统 | RUN_START, RUN_END, SESSION_END, ERROR |

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

| Skill | 路径 | 关键脚本 |
|-------|------|---------|
| guangxi-geodata | `agents/skills/guangxi-geodata/` | geocode.py, query_features.py, fetch_weather.py |
| guangxi-flood-data | `agents/skills/guangxi-flood-data/` | fetch_weather.py, fetch_hydrology.py |
| guangxi-hydrology-web | `agents/skills/guangxi-hydrology-web/` | fetch_rain.py, fetch_river.py |
| gis-bindmap | `agents/skills/gis-bindmap/` | spatial_bindmap.py, distance_matrix.py, basin_bindmap.py |
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

# 后端架构总览

> 变更代码后请同步更新本文档。
>
> 相关规划：
> - [`../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md`](../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md) — Claude Code 对标演进路线图
> - [`../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`](../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md) — 工具体系差异分析

## 目录结构

```
backend-fastapi/
├── agents/                    # 智能体系统
│   ├── core/                  # 基础设施（BaseAgent, Context, Orchestrator, Registry）
│   ├── implementations/       # Agent 实现
│   │   └── orchestrator/      # 统一的通用 ReAct/编排 Agent 实现
│   ├── config/                # Agent 配置管理与 team 模型（manager/loader）
│   ├── configs/               # 源码侧 agent 示例配置与历史输入来源
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
│   └── paths/                 # 路径治理兼容入口（真源见 core/path_resolution.py）
├── hooks/                     # Hook 系统（事件、匹配、执行、内建 hooks）
├── api/v1/                    # FastAPI 路由层
├── runtime/                   # RuntimeContainer 中央容器
├── model_adapter/             # LLM Provider 统一适配
├── mcp/                       # MCP 协议支持
├── services/                  # 业务服务层
├── extensions/                # 扩展加载入口
├── application/               # 应用层（会话、协作）
├── capabilities/              # 能力模块（文档检索、向量检索、MCP）
├── config/yaml/               # 源码侧系统级 app 配置示例
├── execution/                 # 执行层（持久化、可观测性）
├── lifespan.py                # 启动生命周期
├── main.py                    # 应用入口
└── <DATA_ROOT>/              # 运行时数据根目录（默认 ~/.ragsystem，可通过 RAG_DATA_ROOT 覆盖）
    ├── db/                    # 数据库文件（ragsystem.db, checkpoints.db）
    ├── monitoring/
    │   └── session_traces/    # session/run 级调试追踪
    ├── uploads/               # 全局上传文件
    └── sessions/
        └── <session_id>/
            ├── sandbox/       # execute_code 沙箱目录
            ├── workspace/     # 默认会话工作空间
            ├── transient/     # 临时中间数据 / observation 落盘
            ├── uploads/       # session 上传文件
            ├── visualizations/# 可视化 artifact
            └── exports/       # 导出文件（可包含 <run_id>/ 子目录）
```

## 目录桶与落盘分层

| 目录桶 | 物理路径 | 主要内容 | 主要写入入口 | 说明 |
|---|---|---|---|---|
| `sandbox` | 默认 `~/.ragsystem/sessions/<session_id>/sandbox/` | `execute_code` 内部代码写入文件 | `tools/local/code_sandbox.py` | 沙箱专用写入区；代码执行相对写路径默认落这里；对外 display path 仍展示为 `./data/...` |
| `transient` | 默认 `~/.ragsystem/sessions/<session_id>/transient/` | 临时中间数据、observation 大结果物化文件 | `tools.local.document_tools.write_file`（默认输出）、`ArtifactStore.save_text/save_json` | 属于临时文件区，不等于最终交付；对外 display path 仍展示为 `./data/...` |
| `workspace` | 默认 `~/.ragsystem/sessions/<session_id>/workspace/`；若 session.metadata.workspace_root 已配置，则指向该外部绝对目录 | 更稳定的工作文件 | `write_file` + `default_output_space=workspace` | 仅 workspace 工具语义可切到会话级外部目录；uploads 等其他桶不受影响 |
| `exports` | 默认 `~/.ragsystem/sessions/<session_id>/exports/<run_id>/` 或 `~/.ragsystem/sessions/<session_id>/exports/` | 明确导出/交付文件 | `write_file` + `default_output_space=exports` | 面向下载或最终交付 |
| `visualizations` | 默认 `~/.ragsystem/sessions/<session_id>/visualizations/` | 图表、地图、fallback PNG、viz 索引 | `VisualizationArtifactManager`、`visualization_fallback.py` | 可视化专用桶，artifact 主目录 |
| `uploads` | 默认 `~/.ragsystem/uploads/` | 全局上传文件 | `api/v1/files.py` | 全局文件池，服务知识库/向量库管理页，不按 session 分桶 |
| `session_uploads` | 默认 `~/.ragsystem/sessions/<session_id>/uploads/` | 会话私有上传文件 | `api/v1/session_files.py` | session 文件输入区，随 session 生命周期清理 |
| `monitoring/session_traces` | 默认 `~/.ragsystem/monitoring/session_traces/<session_id>/runs/<run_id>/` | 调试消息、运行步骤 JSONL | `execution/persistence/session_trace_writer.py` | 运行跟踪/调试数据，不属于业务文件 |
| `memory` | 默认 `~/.ragsystem/memory/...` | 团队/会话/Agent/workspace 级 Markdown 记忆索引与主题文件 | `services/memory_store.py`、`execution/persistence/message_handler.py` | 参考 Claude Code：启动时注入各作用域 `MEMORY.md` 索引头部，详细记忆由 Agent 按需读取具体 md 文件 |

这些目录桶描述的是运行时默认落盘与默认访问边界；对 direct 文件工具而言，若目标绝对路径超出默认 managed roots，系统会先触发审批，审批通过后仅对当前调用临时授权访问该越界路径，不会重写默认目录桶模型。
| `db` | 默认 `~/.ragsystem/db/` | SQLite 数据库等系统持久化文件 | `ConversationStore`、checkpoint 等 | 系统级持久化，不按 session 分桶 |
| `anonymous fallback` | 逻辑 display path 仍为 `./data/sessions/anonymous/...`，物理默认位于 `~/.ragsystem/sessions/anonymous/...` | 无 session 时的兜底文件 | 多处 fallback | 这是当前保留的系统策略 |

## 请求数据流

```
POST /api/agent/stream {task, attachments[], session_id, selected_llm, llm_tier}
  → api/v1/stream.py
      ├─ 校验 attachments.file_id 是否属于当前 session
      ├─ 将附件补齐为 {file_id, original_name, stored_name, stored_path, mime, size, kind}
      └─ 允许“纯附件消息”：task 为空时，只要 attachments 非空即可发送
  → AgentExecutionAdapter.start_stream_execution()
      └─ 将 current_user_input / current_attachments 注入本次 root context.metadata，并把完整附件元数据写入 user message.metadata.attachments 以供历史回显
  → AgentExecutionService.invoke_agent(mode=root)
  → BaseAgent._prepare_execution_state()
      ├─ 将图片附件放入当前轮 `user_message.metadata.attachments`，供 provider 自动转为多模态输入
      ├─ 将普通文件放入 `user_message.metadata.file_references`
      └─ 额外注入一条 system 提示，告诉 agent 当前有哪些普通文件可按需通过 `read_file` / `preview_data_structure` 读取
  → AgentApiRuntimeService.build_context()
      ├─ 读取历史消息到 AgentContext
      ├─ 保留 user message.metadata.attachments 供前端历史回显
      ├─ 注入 team/session MEMORY.md 索引头部，并在 agent scope 时按当前 session team 隔离 agent memory（Claude Code 风格 eager-load）
      ├─ 根据当前 task 选出相关 memory 文件路径供 Agent 后续按需 read_file
      └─ 注入请求级 LLM 选择：selected_llm（模型身份三元组）/ requested_llm_tier（fast/default/powerful）
  → ModelAdapter.chat_completion_stream()
      └─ provider-specific request build
          ├─ AnthropicProvider._to_content_blocks()：仅图片附件转 `image/base64` block；普通文件不再自动注入 prompt
          └─ OpenAIProvider._normalize_messages()：仅图片附件转 `image_url(data:...)` content part；普通文件不再自动注入 prompt
  → SSEAdapter 转发事件 → 前端

GET /api/agent/sessions/{session_id}/messages
  → api/v1/sessions.py
      ├─ 默认 `expand=none`，历史消息不再内联 `execution_steps`
      ├─ assistant 消息只返回 `has_execution=true/false`，供前端决定是否显示执行树入口
      └─ 显式 `expand=steps` 时，才内联 canonical `execution_steps`

GET /api/agent/sessions/{session_id}/messages/{message_id}/run-steps
  → api/v1/sessions.py
      ├─ 按 message_id 懒加载该条 assistant 消息关联的 canonical `execution.step`
      ├─ 复用 AgentSessionApplication 的 compact 规则，剔除 node_id / timestamp / raw_result 等冗余字段
      └─ 返回分页结构 { items, total, limit, offset, has_more }
```

## Agent 体系

### BaseAgent（agents/core/base.py）

所有 Agent 的抽象基类，核心方法：

| 方法 | 说明 |
|------|------|
| `execute(task, context) → AgentResponse` | 抽象方法，子类必须实现 |
| `can_handle(task, context) → bool` | 判断能否处理任务 |
| `get_llm_config(context=None, task_type=None)` | 统一解析最终 LLM 配置：按 `task_type/requested_llm_tier` 选择 `llm_tiers`，再叠加请求级 `selected_llm` 的模型身份覆盖；agent 侧仅管理模型选择与直接影响交互的参数，provider-specific 字段通过 `extra_params` 透传 |
| `_execute_react_task()` | ReAct 主循环（思考→工具→观察），主推理默认走 `default` tier |
| `_handle_actions()` | 执行工具调用，处理占位符替换 |
| `_resolve_tool_references()` | 解析 `{result_N.path}` 占位符 |
| `_build_system_prompt()` | BaseAgent 的 system prompt 唯一入口，内部委托 `agents/core/prompting.py` 组装共享 skeleton |
| `_build_direct_tools_section()` | 共享 prompt 模块中的 direct 工具段渲染函数，负责调用能力、参数、returns / usage_contract / examples |
| `_setup_react_runtime()` | 初始化上下文管道、观察策略等 |

共享 skeleton 当前固定承载：工作目标、执行决策顺序、工具与执行路径选择、输出格式、停止条件、失败恢复规则，以及按工具能力条件注入的 `execute_code` 提示段；agent 专属策略则通过扩展 section 追加。

关键属性：`name`, `description`, `available_tools`, `available_skills`, `max_rounds`, `model_adapter`, `agent_config`, `_publisher`

LLM 分层配置约定：
- `agent_config.llm`：Agent 主默认模型配置，也是 tier fallback
- `agent_config.llm_tiers`：只承认 `fast/default/powerful` 三档
- agent 级 `llm` 配置只负责模型身份选择与直接影响交互的通用参数：`provider/provider_type/model_name/temperature/max_completion_tokens/max_context_tokens`，
  其他采样或 provider-specific 字段统一通过 `llm.extra_params` / `llm_tiers.*.extra_params` 透传（如 `top_p`、`thinking_budget_tokens`、`reasoning_effort` 等）
- provider-specific 字段统一经 `llm.extra_params` / `llm_tiers.*.extra_params` 透传；`thinking_budget_tokens`、`reasoning_effort` 等能力不再作为 agent 级固定字段
- provider 运行策略（如 timeout、retry_attempts、retry_backoff_factor、prompt cache 策略）不再属于 agent 配置职责，由 provider/runtime 统一管理
- 请求级 `selected_llm`：仅覆盖 `provider/provider_type/model_name`，不覆盖温度、上下文窗口、输出长度或 `extra_params`
- 请求级 `llm_tier`：写入 `AgentContext.requested_llm_tier`，在未显式传 `task_type` 时参与 tier 选择
- 当前已落地两条执行语义：主 ReAct 推理默认走 `default`，上下文压缩摘要走 `fast`

提示词职责分层：
- `BaseAgent`：只保留 system prompt 入口与最小扩展点（如 `_build_agent_specific_prompt_sections()`），运行时通过 `_build_system_prompt()` 调用共享 prompt 组装；默认 section（含 intro）、工具能力判断、code execution prompt 注入与 prompt hook 分发逻辑均不再放在 BaseAgent 中维护
- `agents/core/prompting.py`：共享 prompt skeleton 的唯一实现处，统一维护 intro、执行决策顺序、工具与执行路径选择、direct 工具段渲染、工具契约渲染、停止条件、失败恢复规则、风险操作确认、先读再改、避免过度工程、输出简洁约束、工具能力判断、调用能力标签、managed space 说明、输出格式和通用规则，并按工具能力条件注入 `execute_code` / `call_tool()` / 沙箱文件访问规则；为控制 prompt 长度，工具级 `examples` 仅对白名单中的高复杂度工具展示，`execute_code` 段中的 call_tool 示例使用中性模板而不是写死具体工具名
- `Skills`：具体的 Skill 使用流程、脚本选择、参数约定、领域工作流由各自的 `SKILL.md` 定义
- `OrchestratorAgent`：已收敛为统一的通用 ReAct Agent 实现；在共享 skeleton 之上只覆盖主编排器特有的目标/原则，并在主编排器模式下追加 `call_agent` 契约、委派门槛与 `delegation.enabled_agents` 驱动的动态 agent roster；普通 worker 模式下不暴露委派 roster
- `ToolRegistry` 是运行时唯一读模型：统一提供 direct / document / skill / builtin / agent / mcp 工具视图
- 工具 runtime 已进一步收敛到 Claude Code 风格语义：`tools/runtime/exposure.py` 负责工具暴露真源，`tools/runtime/models.py` 提供统一 `ToolUseContext / ToolExposureDecision / PermissionDecision`，`tools/runtime/executor.py` 以 context 为中心串联 approval / dispatcher / MCP gateway；hooks 空壳已移除；大结果预算控制与落盘由 Observation 路径承接；`execution.step` 与前端 projector 统一消费 `result_preview / raw_result / raw_result_ref`

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

统一的通用 ReAct Agent 实现。主编排器模式下，可通过 `call_agent(agent_name, task, context_hint)` 创建新的子 Agent 会话，并通过 `send_message(child_agent_id, message)` 续接既有子 Agent；普通 worker 模式下则只保留工具调用能力，不暴露 agent roster。所有 orchestrator 型 agent 在运行时都会注入 orchestrator 引用；真正是否作为系统根入口，由配置 `default_entry=true` 与 session 级 `entry_agent` override 共同决定，而不是固定由 `orchestrator_agent` 名称决定。

当前提示词策略采用“直答优先 → direct tool 优先 → 单 Agent 优先 → 多 Agent 仅在必要依赖拆分时使用”的门槛设计：
- 若当前上下文已足够，主编排器应直接输出最终答案，而不是机械委派
- 若一个 direct 工具可完成任务，不升级为子 Agent 协作
- 若确需委派，优先选择一个最匹配的子 Agent；只有存在明确上下游依赖或明显并行收益时才做多 Agent 编排
- 已有合适 `child_agent_id` 时优先 `send_message` 续接既有子 Agent，而不是重复 `call_agent`
- 子 Agent / 工具失败后，下一轮应换策略、补输入或缩小任务，不做原样重试

| 文件 | 职责 |
|------|------|
| `agent.py` | OrchestratorAgent 类：统一承载主编排器与 worker 两种模式，复用 BaseAgent 的 `_build_system_prompt()` 入口和共享 skeleton |
| `prompting.py` | `call_agent` 委派提示段、allowlist agent roster 注入、`replace_placeholders()`；当 agent 无 orchestrator 引用时自动降级为空 roster |
| `tool_router.py` | 统一 direct 工具路由到 dispatcher（含 builtin/agent 工具） |
| `runtime.py` | 运行时入口（当前仅薄封装到 `_execute_react_task()`） |
| `services/agent_execution_service.py` | 统一 agent 执行入口，承接 `/execute`、`/collaborate`、user->agent 与子 Agent turn，并在内部通过 `mode=root|child` 与 `child_agent_id -> thread_key` 收口 root/child 上下文；`/execute` 在显式传 `agent` 时走 `invoke_agent(mode=root)`，未显式传入时走 `invoke_routed_agent()` 复用默认入口路由；`/collaborate` 同样通过 route_task 先解析目标 Agent |


### Team 配置文件切换（索引 + 独立文件）

Agent 配置存储已从“单一 `agent_configs.yaml`”收敛为“team 索引文件 + 每个 team 一份独立 agent 配置文件”：

- 索引文件：默认 `~/.ragsystem/config/agents/team_index.yaml`（若显式设置 `RAG_DATA_ROOT`，则位于 `{RAG_DATA_ROOT}/config/agents/team_index.yaml`）
- team 配置目录：默认 `~/.ragsystem/config/agents/teams/*.yaml`
- `team_index.yaml` 记录：
  - `active_team`
  - `teams: { team_name -> relative_file_path }`
- 每个 team 文件只保存一整份：
  - `agents`
  - `metadata`

当前语义：
- team 仍不是全局 runtime 状态实体，不参与持久化 `active_team` 之外的配置切换语义
- 切换 team 本质上是切换 `active_team` 并重新加载对应文件中的整套 agent 配置
- `AgentConfigManager.get_all_configs()` 始终只返回当前 active_team 的 agent 集合
- execution scope 额外支持 `session.metadata.team` 作为“本次执行的临时 team 配置视图”：`create_execution_orchestrator(session_id=...)` 与 `build_context(session_id=...)` 会优先读取该 team 的配置快照，用于 agent 集合、默认入口和 memory 配置，但**不会**写回或修改全局 `active_team`
- team 也可由 `agents/skills/team-generation/` Skill 生成：Skill 脚本输出标准 `team` 协议后，`tools/local/skill_tools.py:execute_skill_script` 会桥接到 `AgentConfigManager.apply_team_payload()`，将其持久化为普通 team 配置；生成后的 team 与人工创建的 team 在 runtime 语义上没有区别
- `team-generation` 的推荐输入是 `team_goal + roles`，脚本会自动补全每个 agent 的 `display_name`、`description`、`default_entry` 与 `custom_params.behavior.system_prompt`，而不是要求调用方手写全部 AgentConfig
- 因此 `AgentLoader` / `AgentOrchestrator` / `AgentExecutionService` 在 catalog 语义下依旧不需要理解全局 team runtime；session 级 team 仅在 runtime service 收口并向 execution 实例显式下发

迁移策略：
- 若历史上只有单一 `agent_configs.yaml`，`AgentConfigManager` 会在首次加载该旧结构时自动迁移为：
  - `team_index.yaml`
  - `teams/default.yaml`
- 迁移后统一只使用新结构，不再维护长期双结构写回

管理接口：
- `GET /api/agent-config/teams`：返回 `active_team`、team 列表、文件路径与 agent 摘要
- `POST /api/agent-config/teams`：创建 team（可从 source team 复制整份配置）
- `POST /api/agent-config/teams/{team_name}/activate`：切换当前生效 team
- `DELETE /api/agent-config/teams/{team_name}`：删除 team 文件
- `PATCH /api/agent-config/teams/{team_name}/rename`：重命名 team 与文件
- `POST /api/agent-config/teams/{team_name}/copy-agents`：从 source team 复制指定 agents 到目标 team

这套设计的目标不是做 team runtime，而是把 team 收敛为“命名的 agent 配置方案”，便于前端做组合页，再进入现有 AgentConfig 做细调。

### 已配置的 Agent（active_team 下）

当前 active team 下的 Agent 集合属于**运行时配置状态**，来源于 `CONFIG_ROOT/agents/team_index.yaml` 与 `CONFIG_ROOT/agents/teams/*.yaml`，不应在静态架构文档中写死具体 agent 名单或模型版本。

更适合依赖的稳定规则是：
- `custom_params.type`（优先）
- `custom_params.behavior.type`（兼容当前 YAML 结构）

默认入口解析规则：
- 配置层通过 `AgentLoader.resolve_default_entry_agent_name()` 扫描 `default_entry=true`
- runtime 在 `AgentApiRuntimeService._build_orchestrator()` 中把解析结果写入 orchestrator
- `POST /api/agent/execute` 显式传 `agent` 时直接执行该 Agent；未显式传入时走 `invoke_routed_agent()`，由 orchestrator 的默认入口解析决定。同步/流式执行请求都支持请求级 LLM 选择：
- `selected_llm`：API 边缘层解析为结构化模型身份三元组，并透传到 `AgentContext.llm_override`
- `llm_tier`：透传为 `AgentContext.requested_llm_tier`，供运行时在未显式指定 `task_type` 时选择 `fast/default/powerful`
- agent 配置中的 `llm` / `llm_tiers` 仅管理模型身份与直接影响交互的通用参数；provider-specific payload 字段通过 `extra_params` 下传
- session 级 override 预留在 `session.metadata.entry_agent` 与 `session.metadata.team`：
  - `entry_agent` 会在 execution orchestrator 上覆盖默认入口，但不会污染全局 YAML 或 catalog orchestrator
  - `team` 会让本次 execution / context 临时读取该 team 的 agent 配置快照，用于 agent 集合、默认入口解析与 memory 配置；不会切换或写回全局 `active_team`
- `session.metadata.entry_agent='default'` 表示“不覆盖默认入口”；`'orchestrator'` 会在 runtime 归一化为真实 `agent_name` `orchestrator_agent`
- 若 session 级 `entry_agent` 不是当前 execution registry 中存在的真实 agent_name，则 runtime 会忽略该值并保留当前默认入口，避免把 execution orchestrator 覆盖成无效状态
- 若默认入口缺失，则不会再硬编码回退到 `orchestrator_agent`；后续由 orchestrator 的常规能力路由 / 错误处理语义接管
- `call_agent`、`send_message`、`rollback_and_retry`、`recover_session` 这类链路都会继续传入原始 `session_id`，因此也天然继承同一套 session team 临时配置视图

`application/agent_collaboration.py` 中的回退重试也已不再直调 `orchestrator.execute()`：其中 `rollback_and_retry()` 直接复用 `AgentExecutionService.invoke_routed_agent()`；`recover_session()` 因需要先把 checkpoint messages 重放进临时 context，仍保留“checkpoint 注入上下文 + routed agent.execute(context)”的执行形态，但目标 Agent 的选择也已统一复用 execution service 的路由解析。

### 全局权限策略与审批事件

- 当前权限策略仅有全局作用域，唯一状态源为 `tools.permission_manager` 内的全局 `_current_policy`。
- `/api/permissions/policy` 与 `/api/permissions/mode` 只读写全局策略，不引入 session 级权限模式。
- `dangerously_skip_permissions` 的中文语义统一为“跳过审批”，表示跳过常规风险审批，不等于跳过所有 ask。
- `PermissionPolicy.skip_all_approvals` 是独立总开关：为 `true` 时跳过所有 ask 流程（常规风险审批、路径越界审批、hook force_ask、inline approval），但不绕过 `evaluate_tool_permission(...)` 这类执行权限 deny。
- `tools.runtime.approvals.request_user_approval_if_needed()` 在发布 `USER_APPROVAL_REQUIRED` 时，会追加：
  - `permission_mode`：当前全局权限模式
  - `approval_reason`：后端最终审批判定主原因
  - `approval_reason_codes`：结构化审批原因列表（如 `ask-risk`、`ask-path`），可同时包含多个原因
  - `approval_secondary_reasons`：附加原因文本列表，用于双重展示
  - `approved_external_paths`：若本次 direct 文件工具或 `execute_bash` 的工作目录访问的是默认 managed roots 之外的绝对路径，则记录本次审批授权的越界目标路径列表
- 前端直接展示后端给出的 `approval_reason`，并可基于 `approval_reason_codes` 做风险审批/路径越界审批的区分展示；当 `approved_external_paths` 非空时，表示本次审批同时承担“路径边界例外授权”，但该授权仅作用于当前调用，不会永久改变 `workspace_root`、session 目录桶或全局权限模式。

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
- `workspace` 的默认物理目录是 `~/.ragsystem/sessions/<session_id>/workspace/`；若会话在创建时通过 `POST /api/agent/sessions` 传入 `metadata.workspace_root`，则 direct 文件工具、`execute_code` 与 `execute_bash` 在执行期统一切换到该 external workspace
- 前端在创建新会话时，也可通过同一个 `POST /api/agent/sessions` 请求在 `metadata.entry_agent` 中指定该 session 的默认入口 Agent；该值应优先使用真实 `agent_name`。runtime 会在后续执行期读取该字段并覆盖 execution orchestrator 的默认入口，并对 `default/orchestrator` 这类 UI alias 做归一化兜底
- 同一个 session 还可在 `metadata.team` 中指定本次执行临时使用的 team 配置视图；runtime 只在 execution / context 作用域读取该字段，不修改全局 `active_team`
- `AgentApiRuntimeService.build_context()` 会读取 `session.metadata.workspace_root` 并写入本次运行上下文；若配置了 `session.metadata.entry_agent` / `session.metadata.team`，也会一并写入 `context.metadata` 作为观测字段
- `create_execution_orchestrator(session_id=...)` 会为本次执行复制 agent_config 并注入 `custom_params.workspace_root`，同时在 execution orchestrator 上应用 `session.metadata.entry_agent` 默认入口覆盖，以及按 `session.metadata.team` 临时选择 agent 配置快照；这些都只作用于本次 execution 实例，不污染全局 YAML / 其他会话
- `tools.local.document_tools._prepare_document_tool_args()` 会直接从 `agent_config.custom_params` 读取 `workspace_root/default_output_space`，并按“显式 run_id 优先，observability fallback”解析 `effective_run_id`
- `write_file` 未指定路径时由 `resolve_managed_path(..., operation='write')` 按 `default_output_space` 分配受管路径（exports/workspace/transient），其中 `default_output_space=workspace` 会落到当前 effective workspace，而不是固定写死到 session/workspace
- `read_file` / `write_file` / `edit_file` 仅允许 `direct` 调用，不再对 `caller=code_execution` 开放；`preview_data_structure` 仍允许 `code_execution`
- `read_file` 仍保留大文件确认、分页与 direct 调用语义
- sandbox（`tools/local/code_sandbox.py`）保留独立的运行时文件边界：代码中直接使用受限 `open()` 读取和写入文件，写操作由沙箱运行时统一做审批与受管路径校验，底层同样通过 `resolve_managed_path(..., caller='code_execution')` 落到当前 session 的受管目录；其中 `SESSION_WORKSPACE_DIR` / `DATA_DIR` 也会指向同一个 effective workspace
- `execute_bash` 不接入 document 特殊链；它通过 dispatcher 自动注入的 `session_id`、`agent_config.custom_params.workspace_root` 以及 `get_current_execution_observability_fields().run_id` 在工具内部完成统一路径语义解析
- 默认受管目录根的自动补建统一下沉到 `tools/paths/path_resolution.py`：当 direct 工具以目录根语义访问 `workspace/transient/exports`（如 `working_dir` 省略、为空或为 `.`）且目标根目录尚未创建时，共享路径层会先补建对应根目录，再返回解析结果；这样 `execute_bash` 不需要单独维护目录创建分支
- `execute_bash` 在工具内部额外维护一条 bash 专用审批链：白名单命令直接执行，所有非白名单命令统一触发 `user.approval_required`；其中删除、远程下载、解释器 / 子 shell、进程控制、系统控制等高风险命令会在审批 payload 中额外标记并提升风险提示，但不再硬拒绝
- `execute_code` 现已改为“主进程协调 + 沙箱子进程执行”模型：主进程负责静态检查、路径解析、审批等待、工具分发与超时/取消回收，子进程只负责受限 `exec()`；超时和 cancel 会直接终止子进程，因此不再依赖线程内逻辑超时
- dispatcher 对 `execute_code` 做特殊收口：不再走通用 `_run_with_timeout()` 线程包装，而是把 `cancel_event` 直接注入 `tools.local.code_sandbox`，由沙箱内部统一管理 timeout / cancel 语义
- 因此，direct 文件工具路径治理、bash 工作目录解析与沙箱文件访问是三条职责分离但共享同一受管路径语言的链路

XML 解析层修复：`streaming/tool_xml_parser.py` → `_fix_bare_placeholders()` 处理裸占位符

## 长期记忆系统（Claude Code 风格）

长期记忆与 `CLAUDE.md` / rules / 权限治理分层管理：

- `CLAUDE.md` / `.claude/rules`：稳定规则与共享规范
- `~/.ragsystem/memory/...`：learned memory（Markdown）
- settings / permissions / sandbox：真正的强制边界

memory 存储结构：

```text
~/.ragsystem/memory/
├── teams/
│   └── <team_name>/
│       ├── MEMORY.md
│       └── agents/
│           └── <agent_name>/...
├── sessions/
│   └── <session_id>/
│       ├── MEMORY.md
│       └── *.md
└── workspaces/
    └── <workspace_key>/...
```

P1 已完成，落地能力：
- 四层 scope 读取：`team` / `session` / `agent` / `workspace`
- `session` 层 root final_answer 自动写入
- `MEMORY.md` 作为索引入口（`load_index_head` 限 200 行 / 25KB）
- 单条记忆单独 Markdown 文件保存 frontmatter + 正文
- 按 agent 配置的 `allowed_scopes` / `write_scopes` / `archive_scopes` 精细授权
- 基于 query 的跨 scope 记忆检索（`search_memories`，默认 top 5）
- 采用索引注入 + 按需读取模型，不需要全局压缩/淘汰

加载机制参考 Claude Code：
- 会话开始 / build_context 时，不把所有记忆正文注入 prompt
- 只注入各作用域 `MEMORY.md` 的头部索引内容
- 同时在 prompt 中提供相关记忆文件路径
- Agent 如需细节，再直接调用 `read_file` 读取对应 md 文件
- system prompt 还会显式注入当前 Agent 的 memory scope 能力摘要（可读取 / 可写入 / 可归档哪些 scope），降低误操作风险

当前默认 scope chain：
- 仅当存在任一 memory scope 权限，且 `memory.auto_inject=true` 时，按 `allowed_scopes` 自动注入索引
- `team` 注入团队级 MEMORY.md
- `session` 注入当前会话 MEMORY.md
- `agent` 仅注入当前正在运行的 `agent_name` 对应私有 MEMORY.md
- `workspace` 仅在当前 session 存在有效 workspace 根路径时注入对应 MEMORY.md；`workspace_key` 不再取目录 basename，而是基于完整 workspace 路径生成稳定 key
- 自动检索相关记忆（`memory_query`）时，scope chain 也与上述规则保持一致
- 默认推荐 `team -> session`

memory 工具不再对所有 Agent 默认开放，而是由 memory 配置中的 scope 权限自动推导；当前运行时仍保留一个显式总开关：
- 若 `memory.enabled=false`，memory 工具整体不注入
- `allowed_scopes` 非空：自动注入 `list_memory_index`、`read_memory_entry`
- `write_scopes` 非空：额外自动注入 `write_memory`
- `archive_scopes` 非空：额外自动注入 `archive_memory`
- 前端和配置层不再把 `memory.enabled_tools` 作为独立开关维护

运行时的 direct tool 判定已统一到底层 effective direct tools：
- 产品/配置层仍保留独立的 `memory` 配置区；
- 但在 `AgentLoader._resolve_tools_and_skills()` 与 `tools/permissions.py` 中，memory 工具是否注入完全由三个 scope 列表自动推导；
- `tools/local/memory_tools.py` 运行时只检查“是否存在任一 memory scope 权限”与对应 scope 权限，不再依赖独立总开关；
- 因此 prompt 可见工具、loader 注入结果与实际可调用权限保持一致，不再出现配置层/运行时的双重开关分叉。

memory 当前采用纯 scope 授权模型：
- `allowed_scopes` / `write_scopes` / `archive_scopes` 直接决定读取 / 写入 / 归档能力；
- `auto_inject` 只控制是否自动注入记忆索引与检索结果，不承担启停 memory 的职责；
- prompt 层：`AgentApiRuntimeService.build_context()` 会把 scope 能力写入 `context.metadata['memory_scope_capabilities']`，`ContextPipeline._build_memory_block()` 再把它渲染进 system prompt，明确告知 Agent 当前可操作哪些 scope；
- 配置页：`AgentConfigService.get_memory_config_metadata()` 仅向前端提供 scope 说明，前端 UI 只管理 scope 权限与 `auto_inject`，不再渲染“启用记忆”总开关。

非默认启用 scope（已实现，需在 agent 配置中显式添加）：
- `agent`：当前运行的 Agent 私有记忆
- `workspace`：需存在有效 workspace 根路径后自动生成稳定 `workspace_key`

当前 root final_answer 的 session memory 规则抽取先覆盖少量高价值偏好：
- 使用中文
- 优先最少代码
- 不要兼容层

后续 P2（反思机制）和 P3（自进化）可在此基础上继续扩展。

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
- dispatcher 基于 `check_tool_permission() + auto-accept 规则 + permission mode + risk_level` 的通用工具审批（四档模式：`strict` 全部审批、`standard` 默认中/高风险审批、`relaxed` 仅高风险审批、`dangerously_skip_permissions` 全部跳过；`auto-accept` 始终优先）
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
- `AgentSessionApplication.list_messages()` 默认只展示 root 主消息流；会过滤 `react_intermediate`、`visible_to_user=False`、`conversation_scope='child'` 与非 `root` 线程消息；child 对话主要用于上下文恢复与调试
- 历史消息接口默认不再内联 `execution_steps`；assistant message 只返回 `has_execution`，表示该消息是否可继续懒加载执行树 sidecar

统一执行树的唯一事实源是 **canonical `execution.step`**：

- 原始 EventBus 事件只作为运行时内部事件
- `execution/step_projector.py` 监听原始事件并投影出 `execution.step`
- `run_steps.step_type` 固定存 `execution.step`
- `run_steps.payload` 只持久化 canonical step 的精简字段集合：保留 UI 所需的结构/状态/展示字段；`intent delta` / `round update` 这类纯流式碎片不入库；`event_id`、`timestamp`、`source_event_type`、`node_id`、`parent_node_id`、`child_agent_id`、`mode`、`raw_result_ref`、`resource_refs` 等调试/冗余字段不写入 payload
- `application/agent_session.py:list_messages()` 默认只返回消息主载荷；仅在显式 `expand=steps` 时才内联裁剪后的 `execution_steps`
- `application/agent_session.py:list_message_run_steps()` 提供按 `message_id` 懒加载 execution steps 的 sidecar 读取能力，返回裁剪后的步骤分页结果
- `api/v1/sessions.py` 暴露 `GET /sessions/{session_id}/messages/{message_id}/run-steps`，供前端按消息懒加载执行树
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
- 名称规则：后端 canonical `execution.step` 在 `run / subtask / intent / tool` 上统一透传 `agent_name` 与 `agent_display_name`；前者用于稳定标识，后者用于 UI 展示，缺失时才回退到 `agent_name`
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

Run 级事件总线不再为已结束 run 保留额外 TTL：`RUN_END` 只负责终止语义与事件分发，真正的 EventBus 清理由各执行入口在流/执行完成后显式调用 `cleanup_run(run_id)` 完成。`SSEAdapter.stop()` 为幂等清理，允许 `stream_sync().finally` 与外层 cleanup callback 重复调用而不产生重复停止日志。

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
| `CONFIG_ROOT/agents/team_index.yaml` | 当前 active team 与 team 索引 | 支持 |
| `CONFIG_ROOT/agents/teams/*.yaml` | Agent 定义（LLM、工具、Skills、MCP、delegation、memory） | 支持 |
| `CONFIG_ROOT/model_adapter/providers.yaml` | LLM Provider（API key、模型列表） | 支持 |
| `CONFIG_ROOT/mcp/mcp_servers.yaml` | MCP 服务器连接 | 支持 |
| `CONFIG_ROOT/app/config.yaml` | 系统级（向量库、embedding、hooks.workspace_trust） | 否 |

- 以上 `CONFIG_ROOT` 默认位于 `~/.ragsystem/config`；若显式设置 `RAG_DATA_ROOT`，则位于 `{RAG_DATA_ROOT}/config`
- 源码目录中的 app / agent `.example` 文件仅作为启动时初始化来源；MCP 与 model provider 配置需直接在运行时目录维护，不是正式运行时配置位置
- legacy `CONFIG_ROOT/agents/agent_configs.yaml` 仅作为迁移输入；当前正式 Agent 配置模型以 `team_index.yaml + teams/*.yaml` 为准
- `CONFIG_ROOT/agents/teams/*.yaml` 中的 Agent 配置包含显式能力域：`tools.enabled_tools`、`skills.enabled_skills`、`mcp.enabled_servers`、`delegation.enabled_agents`、`memory.*`
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
| `/api/agent/execute` | `api/v1/execution.py` | 同步执行与执行概览 |
| `/api/agent/sessions` | `api/v1/sessions.py` | 会话管理 |
| `/api/agent-config` | `api/v1/config.py` | Agent 配置 CRUD |
| `/api/model-adapter` | `api/v1/models.py` | LLM Provider 管理 |
| `/api/mcp` | `api/v1/mcp.py` | MCP 服务器管理 |
| `/api/files` | `api/v1/files.py` | 全局文件池 |
| `/api/agent/sessions/{session_id}/files` | `api/v1/session_files.py` | 会话文件管理 |
| `/api/artifacts` | `api/v1/artifacts.py` | 可视化 artifact |
| `/api/vector-library` | `api/v1/vector.py` | 向量库与向量化器管理 |
| `/api/vector` | `api/v1/vector_management.py` | 向量集合、索引与检索 |
| `/api/embedding-models` | `api/v1/embedding_models.py` | Embedding 模型管理 |
| `/api/permissions` | `api/v1/permissions.py` | 全局权限策略 |
| `/api/monitoring` | `api/v1/monitoring.py` | 监控与诊断 |

## 新增 Agent 步骤

1. `agents/implementations/<name>/agent.py` — 继承 BaseAgent，实现 `execute()` + `can_handle()`
2. `agents/core/registry.py` — 注册
3. `CONFIG_ROOT/agents/teams/<team>.yaml` — 在目标 team 配置文件中添加 Agent；必要时同步 `CONFIG_ROOT/agents/team_index.yaml` 指向 active team（默认位于 `~/.ragsystem/config/agents/`）
4. 更新本文档

## 新增 LLM Provider 步骤

1. `integrations/model_providers/` — 创建 Provider 类
2. `CONFIG_ROOT/model_adapter/providers.yaml` — 添加配置（默认 `~/.ragsystem/config/model_adapter/providers.yaml`）
3. 更新本文档

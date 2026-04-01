# 工具系统

> 变更工具代码后请同步更新本文档。
>
> 相关规划：
> - [`../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md`](../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md) — Claude Code 对标演进路线图
> - [`../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`](../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md) — 工具体系差异分析

## 目录结构

```
tools/
├── contracts/                        # 纯定义层：Contract / Result / Permission 模型
│   ├── tool_contracts.py             # ToolContract + OpenAI 函数定义构建
│   ├── result_models.py              # ToolExecutionResult / ArtifactRef
│   └── permissions.py                # RiskLevel / ToolPermission 纯模型
├── runtime/                          # 运行时装配与执行边界
│   ├── bootstrap.py                  # bootstrap_tool_system() 真实实现
│   ├── discovery.py                  # 自动扫描 @tool() 模块
│   ├── registration.py               # TOOL_HANDLERS + _merge_decorated_handlers()
│   ├── approvals.py                  # 通用审批等待与 approval gate
│   ├── dispatcher.py                 # 本地 handler 分发 + MCP gateway 薄封装
│   ├── mcp_gateway.py                # MCP 运行时命名解析与统一执行入口
│   ├── executor.py                   # execute_tool() 主执行编排
│   ├── response_builder.py           # success_result() / error_result()
│   ├── result_normalizer.py          # 结果规范化
│   └── tool_output_type_audit.py     # 工具输出形态审计脚本
├── local/                            # 本地工具真实实现
│   ├── document_tools.py             # 文件类 document 工具实现
│   ├── code_sandbox.py               # Python 代码沙箱
│   ├── skill_tools.py                # Skill 执行（含 artifact 协议桥接）
│   ├── builtin_tools.py              # builtin 工具（request_user_input）
│   ├── agent_tools.py                # agent delegation 工具（call_agent）
│   ├── bash_tool.py                  # Bash 命令执行
│   └── shared.py                     # 本地工具共享依赖
├── refs/                             # 结果引用与占位符解析
│   └── result_references.py          # 占位符路径解析 + 错误标记 + 未替换检测
├── artifacts/                        # 可视化 artifact 子域
│   ├── visualization_artifact_manager.py # 可视化 artifact 持久化
│   └── visualization_fallback.py     # 可视化降级
├── paths/                            # 路径治理子域
│   └── path_resolution.py            # 全局路径管理中心（DATA_ROOT、目录常量、session 级路径）
├── catalog/                          # 协议型适配（当前仅 MCP）
│   └── mcp_tools.py                  # MCP 工具适配
├── decorators.py                     # @tool() 装饰器（合并 Contract+Permission+Handler）
├── consistency_check.py              # 工具注册一致性校验
├── tool_registry.py                  # ToolRegistry 唯一读模型
├── bootstrap.py                      # 稳定 public API：指向 runtime.bootstrap
├── tool_executor.py                  # 稳定 public API：指向 runtime.executor
└── __init__.py
```

## 目录桶与落盘入口

| 目录桶 | 物理路径 | 主要内容 | 主要写入入口 | 说明 |
|---|---|---|---|---|
| `sandbox` | `./data/sessions/<session_id>/sandbox/` | `execute_code` 内部代码写入文件 | `tools/local/code_sandbox.py` | 沙箱专用写入区；代码执行相对写路径默认落这里 |
| `transient` | `./data/sessions/<session_id>/transient/` | 临时中间数据、observation 大结果物化文件 | `tools.local.document_tools.write_file`（默认输出）、`ArtifactStore.save_text/save_json` | 属于临时文件区，不等于最终交付 |
| `workspace` | 默认 `./data/sessions/<session_id>/workspace/`；若 session.metadata.workspace_root 已配置，则指向该外部绝对目录 | 更稳定的工作文件 | `write_file` + `default_output_space=workspace` | 仅 workspace 工具语义可切到会话级外部目录；uploads 等其他桶不受影响 |
| `exports` | `./data/sessions/<session_id>/exports/<run_id>/` 或 `./data/sessions/<session_id>/exports/` | 明确导出/交付文件 | `write_file` + `default_output_space=exports` | 面向下载或最终交付 |
| `visualizations` | `./data/sessions/<session_id>/visualizations/` | 图表、地图、fallback PNG、viz 索引 | `VisualizationArtifactManager`、`visualization_fallback.py` | 可视化专用桶，artifact 主目录 |
| `uploads` | `./data/uploads/` | 全局上传文件 | `api/v1/files.py` | 全局文件池，服务知识库/向量库管理页 |
| `session_uploads` | `./data/sessions/<session_id>/uploads/` | 会话私有上传文件 | `api/v1/session_files.py` | session 文件输入区，随 session 生命周期清理 |
| `monitoring/session_traces` | `./data/monitoring/session_traces/<session_id>/runs/<run_id>/` | 调试消息、运行步骤 JSONL | `execution/persistence/session_trace_writer.py` | 运行跟踪/调试数据，不属于业务文件 |
| `db` | `./data/db/` | SQLite 数据库等系统持久化文件 | `ConversationStore`、checkpoint 等 | 系统级持久化，不按 session 分桶 |
| `anonymous fallback` | `./data/sessions/anonymous/...` | 无 session 时的兜底文件 | 多处 fallback | 这是当前保留的系统策略 |

### 统一原则（v3）

- **除 MCP 外，所有可执行能力统一走 `@tool()`**
- 当前真实结构只保留 `contracts / runtime / local / refs / artifacts / paths / catalog`
- `tools/` 根目录不再保留兼容 facade；稳定入口仅剩 `tools.bootstrap` 与 `tools.tool_executor`
- builtin `request_user_input` 已是真正的 `@tool(source="builtin")`
- agent delegation 已收敛为 `@tool(source="agent")` 工具组：`call_agent` + `send_message`
- 可委派子 Agent 由 `delegation.enabled_agents` allowlist 控制，prompt 层只动态注入 roster，不再动态生成 `invoke_agent_*`
- `ToolRegistry` 是运行时、loader、prompt、测试的唯一读模型；MCP contract/schema 适配仍来自 `tools.catalog.mcp_tools`，但运行时命名解析统一复用 `tools.runtime.mcp_gateway`
- runtime 层负责 discovery / registration / approval / dispatch / execute；其中 MCP 采用“外部展开、内部单网关”：Agent 仍看到 `mcp__<server>__<tool>`，实际执行与 observability 透传统一收敛到 `tools.runtime.mcp_gateway`
- 历史顶层目录 `data/artifacts`、`data/transient`、`data/exports`、`data/workspace` 已不再作为主写入模型

## 新增工具注册

所有本地工具统一通过 `@tool()` 注册；MCP 是唯一保留的外部适配例外。

### @tool() 装饰器注册（唯一入口）

在工具函数上添加 `@tool()` 装饰器，一处定义 Contract + Permission + Handler：

```python
from tools.decorators import tool
from tools.permissions import RiskLevel

@tool(
    name="my_tool",
    description="工具描述",
    parameters={...},
    risk_level=RiskLevel.LOW,
    timeout_seconds=60,
    allowed_callers=["direct"],
    returns={...},
    usage_contract=[...],
    examples=[...],
    source="decorator",          # 默认值；Skill 工具用 "skill"
)
def my_tool(arguments, **kwargs):
    ...
```

启动时统一通过 `bootstrap_tool_system()` 完成：

1. `discover_decorated_tools()`
2. `_merge_decorated_handlers()`
3. `_merge_decorated_permissions()`
4. `ToolRegistry.register_contracts()`
5. `check_tool_consistency()`

`source` 字段决定工具分类：
- `document` / `decorator`：本地 direct 工具
- `skill`：Skill 系统工具
- `builtin`：框架内置工具（如 `request_user_input`）
- `agent`：子 Agent delegation 工具（`call_agent` / `send_message`）
- `mcp`：外部 MCP adapter 例外

已迁移的本地工具（15 个）：
- `local/skill_tools.py`: activate_skill, load_skill_resource, execute_skill_script, get_skill_info
- `local/code_sandbox.py`: execute_code
- `local/document_tools.py`: write_file, read_file, preview_data_structure, edit_file
- `local/builtin_tools.py`: request_user_input
- `local/agent_tools.py`: call_agent, list_child_agents, send_message
- `local/memory_tools.py`: list_memory_index, read_memory_entry, write_memory, archive_memory

已迁移为 Skill 脚本的工具（8 个，P5 工具轻量化）：
- 可视化工具 → `agents/skills/visualization/` Skill：create_chart, create_map, create_bindmap, revise_visualization
- 应急工具 → `agents/skills/emergency-decision-support/` Skill：query_emergency_plan, assess_flood_risk, match_emergency_response, create_risk_map 等
- Skill 脚本通过 `execute_skill_script` 调用，输出 artifact 协议格式时系统自动完成可视化持久化


### 统一运行时收敛（P1-P4）

当前工具 runtime 已完成进一步收敛，语义上更贴近 Claude Code：

- `tools/runtime/exposure.py` 成为 Agent 工具暴露真源：统一解析 direct / memory 派生工具 / skill system tools / builtin / delegation / MCP server 工具暴露
- `tools/permissions.py` 明确拆分“暴露权限”与“执行权限”，并输出结构化 `PermissionDecision`
- `tools/runtime/executor.py` 内部统一先构造 `ToolUseContext`，approval / dispatcher / mcp gateway 复用该上下文
- hooks 空壳骨架已移除；未来需要时再按 Claude Code 模式补真实 shell hook registry
- Observation 路径已承接大结果预算控制：`ObservationPolicy` 输出 `inline / artifact_ref` 两阶段决策，`PromptMaterializer` + `LargePayloadFormatter` 在 observation 格式化阶段完成落盘
- `CALL_TOOL_END` / `execution.step` / 前端 `executionProjector.js` 统一围绕 `result_preview / raw_result / raw_result_ref / approval_message` 工作

这意味着 direct / skill / MCP 工具虽然实现来源不同，但运行时都尽量复用同一条 context / permission / result 主链，避免再次分叉出第二套 runtime。


> 提示词层已统一：direct 工具的 `调用能力`、参数、`returns / usage_contract / examples`、`workspace / transient / exports` 说明，统一由 `agents/core/base.py` 的共享 prompt skeleton 渲染；`BaseAgent` 还会按是否具备 `execute_code` 能力条件注入代码执行说明，`OrchestratorAgent` 仅补 Agent delegation 的专属操作说明；入口 orchestrator 的 YAML `system_prompt` 只保留业务路由信息，避免重复覆盖通用协议规则。

```
execute_tool(tool_name, arguments, agent_config, event_bus, user_role, caller, session_id, run_id, cancel_event, parent_call_id, current_agent_name, tool_call_id)
  ├─ _request_user_approval_if_needed()
  │   ├─ check_tool_permission()  → (allowed, error_msg)
  │   └─ 根据 auto-accept 规则 + risk_level + permission mode 判断是否需要审批，若需要则发布 `user.approval_required` 事件并携带 `permission_mode`、`approval_reason` 后等待用户确认
  ├─ 获取 timeout_seconds（来自 ToolPermission，默认 60s）
  ├─ 分发
  │   ├─ tool_name in TOOL_HANDLERS
  │   │   ├─ execute_code → 直接调用 handler（子进程内部自管理 timeout/cancel）
  │   │   ├─ execute_bash → 先进入 bash_tool 内部命令校验（三态：直通 / 审批 / 硬拒绝）
  │   │   └─ 其他工具 → _run_with_timeout(handler, timeout)（自动注入上下文参数）
  │   ├─ is_mcp_tool(tool_name) → dispatcher.execute_mcp_tool() → runtime.mcp_gateway.execute_mcp_tool()
  │   └─ else → error_result()
  ├─ _normalize_tool_result() → 统一为 ToolExecutionResult
  └─ 返回 ToolExecutionResult
```

### 全局权限模式

- 当前权限模式由 `tools.permission_manager` 的全局 `PermissionPolicy` 统一管理。
- `/api/permissions/policy`、`/api/permissions/mode` 只操作全局策略，不区分 session。
- `dangerously_skip_permissions` 表示“跳过审批”。
- 审批事件 `user.approval_required` 会直接下发后端判定得到的 `permission_mode` 与 `approval_reason`，供前端展示。

### builtin 与 agent delegation

- `request_user_input` 已从 pseudo-tool 收敛为真实 `@tool(source="builtin")`
- `call_agent`、`list_child_agents` 与 `send_message` 共同构成 `source="agent"` delegation 工具面
- `call_agent` 负责创建新的 child agent 会话并返回 `child_agent_id`
- `list_child_agents` 负责列出当前 session 下已创建的 child agent，便于找回 `child_agent_id`
- `send_message` 负责向既有 child agent 发送新消息并续接上下文
- 子 Agent 是否可调用不再由工具名展开决定，而由 `delegation.enabled_agents` + prompt 动态 roster 决定

### 文件类 document 工具路径治理（local.document_tools._prepare_document_tool_args）

4 个文件类 document 工具已经和其他 `@tool()` 工具完全同构：由自动发现注册进入统一 `TOOL_HANDLERS`，dispatcher 不再维护 document 特判分支。文件路径治理则直接内聚在 `tools.local.document_tools` 内部私有 helper：

```
占位符替换（base.py._handle_actions）
  → dispatcher 统一命中 TOOL_HANDLERS
    → local.document_tools._prepare_document_tool_args / local.bash_tool._resolve_work_dir
      → tool 执行（local.document_tools / local.bash_tool）
        → resource scope 推断/清理（conversation_store._infer_scope）
```

统一规则：
- direct 文件工具支持 XML 写法 `<file_path space="workspace|transient|exports">relative/path</file_path>`
- `execute_bash` 支持 XML 写法 `<working_dir space="workspace|transient|exports">relative/dir</working_dir>`
- XML 解析层会将其分别扁平化为 `file_path + file_path_space`、`working_dir + working_dir_space`
- `tools.local.document_tools._prepare_document_tool_args()` / `local.bash_tool._resolve_work_dir()` 在消费完 `file_path_space` / `working_dir_space` 后，不再继续透传到底层 I/O 逻辑
- `space` 仅影响相对 path / dir 的解析根：`workspace` → 当前 effective workspace，`transient` → `./data/sessions/<session_id>/transient/`，`exports` → `./data/sessions/<session_id>/exports/<run_id>/`（缺 `run_id` 报错）
- document 工具中的 `run_id` 由工具函数优先使用显式参数，缺失时 fallback 到 `get_current_execution_observability_fields().run_id`
- 绝对路径不会被 `space` 改写，仍只做受管边界校验
- direct 文件工具的相对 `file_path` 默认按 workspace 解析；`execute_bash` 的相对 `working_dir` 默认也按 workspace 解析
- `write_file` 未指定 `file_path` 时：根据 `default_output_space` 分配到 `./data/sessions/<session_id>/exports/<run_id>/`、当前 effective workspace（默认 `./data/sessions/<session_id>/workspace/`，若会话 metadata.workspace_root 已配置则改用该外部目录）或 `./data/sessions/<session_id>/transient/`
- `caller=direct` 的 direct 文件工具仍通过 `path_resolution.resolve_managed_path(...)` 解析文件路径；`execute_bash` 在工具内部通过 `path_resolution.resolve_managed_directory(...)` 解析工作目录
- `workspace_root` 由 `POST /api/agent/sessions` 写入 `session.metadata.workspace_root`，运行期由 `AgentApiRuntimeService` 读取并只注入本次执行的 `agent_config.custom_params.workspace_root`
- 文档工具的 `read_file` / `write_file` / `edit_file` 仅支持 `direct` 调用，不再对 `caller=code_execution` 开放
- `preview_data_structure` 仍允许 `code_execution` 调用
- 代码沙箱内部的文件访问不走文档工具链；沙箱代码读文件使用受限 `open()`，写文件先 `request_write_approval()` 再 `open()`，仍受 `resolve_managed_path(..., caller='code_execution')` 的受管边界约束；`SESSION_WORKSPACE_DIR` / `DATA_DIR` 与 direct 工具共享同一套 effective workspace 定义
- `content.file_path` 为内部绝对路径（供链式调用），`content.display_path` 为可读展示路径（供用户展示）
- 链式调用占位符统一使用单花括号：`{result_N}`、`{result_N.content.file_path}`；不要写成双花括号 `{{result_N}}`

### MCP：外部展开，内部单网关

MCP 在本轮保持 **LLM 可见工具面不变**：Agent / ToolRegistry / prompt 仍看到展开后的 `mcp__<server>__<tool>`。

但内部运行时职责已收敛为单一 gateway：

- `tools/catalog/mcp_tools.py`：只负责把 MCP tool schema 适配为 ToolContract / function tool schema
- `tools/runtime/mcp_gateway.py`：统一负责 `MCP_TOOL_PREFIX`、`is_mcp_tool()`、`parse_mcp_tool_name()`、`execute_mcp_tool()`
- `tools/runtime/dispatcher.py`：仅保留对 gateway 的薄封装，不再自行解析 MCP 工具名
- `tools/permissions.py`：继续负责 server enablement、config store fallback 注册、caller/role 校验，但 MCP 解析统一复用 gateway
- `services/mcp_service.py`：继续作为真实业务调用入口，gateway 最终通过 `get_mcp_service().call_tool(...)` 发起调用

执行链路：

```
Agent 可见工具: mcp__server__tool
  → execute_tool()
    → dispatcher.execute_mcp_tool()
      → runtime.mcp_gateway.execute_mcp_tool()
        → get_current_execution_observability_fields()
        → services.mcp_service.MCPService.call_tool()
```

这保证了“对外工具面不变、对内运行时收口”。


### memory 工具（agent-first）

memory 采用 Claude Code 风格的“索引注入 + 明细按需读取”模型，但当前系统是 agent-first，因此除 runtime 自动注入 `MEMORY.md` 索引外，还为 Agent 提供了显式的 memory 操作工具。

其中以下 memory 工具属于 **默认工具**，不需要在 agent 配置页面单独勾选：
- `list_memory_index`
- `read_memory_entry`
- `write_memory`
- `archive_memory`

这样所有 Agent 默认都具备最小 memory 操作能力；其他 direct 工具仍按 `enabled_tools` 配置过滤。

- `list_memory_index(scope, ...)`
  - 读取指定作用域 `MEMORY.md` 的头部索引
  - 适合先了解有哪些记忆，再决定是否读取明细
- `read_memory_entry(scope, file_name, ...)`
  - 读取单条具体记忆 md 文件正文
  - 适合 Agent 在看到索引后按需展开细节
- `write_memory(scope, name, description, memory_type, content, ...)`
  - 新增或更新一条记忆，并同步重建 `MEMORY.md`
- `archive_memory(scope, file_name, ...)`
  - 将一条记忆标记为 archived，使其不再参与默认索引和检索

当前默认作用域链仍为：
- `project -> session`

但 Agent 已可以显式操作：
- `project`
- `session`
- `agent`
- `workspace`

这与纯后台 memory 检索不同：memory 对 Agent 是可见、可读、可操作对象。

### ToolExecutionResult（contracts/result_models.py）

```python
@dataclass
class ToolExecutionResult:
    success: bool                    # 执行是否成功
    tool_name: str                   # 工具名称
    summary: str                     # 执行摘要
    answer: Optional[str]            # 可选答案
    output_type: str                 # text/json/chart/map/error/markdown
    content: Any                     # 主要内容（工具返回的实际数据）
    metadata: Dict[str, Any]         # 元数据
    artifacts: List[ArtifactRef]     # 关联的 artifact
    llm_hint: Optional[str]          # 给 LLM 的提示
```

### ToolContract（contracts/tool_contracts.py）

`examples` 中的 `input` 同时用于 JSON 契约展示和 prompt 中的 XML 示例渲染：
- 当示例需要展示 XML 属性（如 `space="transient"`）时，不要把 `<file_path ...>...</file_path>` 或 `<working_dir ...>...</working_dir>` 作为字符串塞进 `input`
- 应保持 `input.file_path="tmp.txt"` / `input.working_dir="."`，并额外通过 `xml_attrs` 描述要渲染到 XML 标签上的属性
- JSON 调用时应显式传 `file_path_space` / `working_dir_space`，不要传字符串化 XML 标签

```python
@dataclass
class ToolContract:
    name: str                        # 工具名称
    description: str                 # 描述
    parameters: dict                 # JSON Schema 参数定义
    returns: dict | None             # 返回值 Schema
    usage_contract: list[str]        # 使用约定（给 LLM 的指导）
    examples: list[dict]             # 使用示例
    tags: list[str]                  # 标签
    source: str                      # decorator/skill/document/builtin/agent/mcp
```

### 权限配置（permissions.py / contracts/permission_modes.py）

```python
class ToolPermission:
    tool_name: str
    risk_level: RiskLevel            # LOW / MEDIUM / HIGH
    description: str
    allowed_roles: list              # 空=所有角色
    allowed_callers: list            # direct / code_execution
    timeout_seconds: int             # 执行超时秒数（默认 60，0=不限制）

class PermissionMode(str, Enum):
    STRICT = "strict"                        # 全部风险工具需审批；命中 auto-accept 时仍可跳过
    STANDARD = "standard"                    # 默认 MEDIUM/HIGH 风险需审批；命中 auto-accept 时可跳过
    RELAXED = "relaxed"                      # 仅 HIGH 风险需审批；命中 auto-accept 时可跳过
    DANGEROUSLY_SKIP_PERMISSIONS = "dangerously_skip_permissions"  # 跳过所有审批
```

当前审批语义：
- 先做 `check_tool_permission()`，处理 caller / role / server enablement 等授权约束
- 再按 `auto-accept 规则 -> permission mode -> risk_level` 判断是否需要用户审批
- `strict`：LOW / MEDIUM / HIGH 全部需要审批
- `standard`：MEDIUM / HIGH 需要审批（默认档）
- `relaxed`：仅 HIGH 需要审批
- `dangerously_skip_permissions`：全部不审批
- `auto-accept` 优先级高于模式判断，因此即使在 `strict` 模式下，命中规则的工具仍可自动通过
- 慢工具超时配置：`execute_skill_script` 设为 120s

### 结果规范化（dispatcher._normalize_tool_result）

dispatcher 在返回结果前统一规范化，确保调用方始终拿到 `ToolExecutionResult`：

| 工具返回值 | 规范化行为 |
|-----------|-----------|
| `ToolExecutionResult` | 直接返回 |
| `None` | `error_result("工具返回了空结果")` |
| `dict` | `success_result(content=result)` |
| 其他类型 | `success_result(content=str(result))` |

## 工具清单

### 可视化工具（已迁移为 Skill：`visualization`）

原 `visualization_tools.py` 中的 4 个工具已迁移为 `agents/skills/visualization/` Skill 脚本：

| 原工具 | 对应 Skill 脚本 | 说明 |
|--------|-----------------|------|
| `create_chart` | `visualization/scripts/create_chart.py` | ECharts 图表生成 |
| `create_map` | `visualization/scripts/create_map.py` | Leaflet 地图生成 |
| `create_bindmap` | `visualization/scripts/create_bindmap.py` | 多图层叠加地图 |
| `revise_visualization` | `visualization/scripts/revise.py` | 修改已有 artifact |

调用方式：通过 `execute_skill_script(skill_name="visualization", script_name="create_chart.py", arguments=[...])` 调用。
脚本输出 artifact 协议格式，`execute_skill_script` 自动完成可视化持久化并返回 `artifact_id`。

### 应急工具（已迁移为 Skill：`emergency-decision-support`）

原 `emergency_tools.py` 中的 4 个工具，以及原报告生成功能，已统一迁移为 `agents/skills/emergency-decision-support/` Skill 脚本：

| 原工具 | 对应 Skill 脚本 | 说明 |
|--------|-----------------|------|
| `query_emergency_plan` | `emergency-decision-support/scripts/query_plan.py` | 预案向量检索 |
| `assess_flood_risk` | `emergency-decision-support/scripts/assess_flood_risk.py` | 洪涝风险评估 |
| `match_emergency_response` | `emergency-decision-support/scripts/match_response.py` | 响应匹配（1:1 Skill 化封装） |
| `create_risk_map` | `emergency-decision-support/scripts/create_risk_map.py` | 批量评估+风险地图（输出 artifact 协议） |
### Skill 工具（local/skill_tools.py）

| 函数 | 参数 | 说明 |
|------|------|------|
| `activate_skill` | skill_name | 激活 Skill，加载 SKILL.md |
| `load_skill_resource` | skill_name, resource_file | 加载 Skill 资源文件 |
| `execute_skill_script` | skill_name, script_name, arguments, session_id | 执行 Skill 脚本（含 artifact 协议桥接） |
| `get_skill_info` | skill_name | 获取 Skill 元信息 |

### 文档工具（local/document_tools.py）

当前 document 实现已经收敛到本地真实模块，只保留受管路径协议与文件 I/O 边界。

| 函数 | 参数 | 说明 |
|------|------|------|
| `preview_data_structure` | file_path | 预览文件数据结构 |
| `write_file` | content, file_path, encoding | 写文件（仅支持 direct） |
| `read_file` | file_path, encoding, offset, limit | 读文件（分页，仅支持 direct） |
| `edit_file` | file_path, old_text, new_text, encoding | 编辑文件（仅支持 direct） |

### 代码沙箱（local/code_sandbox.py）

`execute_code_sandbox(code, description, timeout, ..., cancel_event=None)` — 受限 Python 执行环境。

当前实现为**主进程协调 + 子进程执行**：

- 主进程保留静态检查、路径解析、工具分发、审批等待与结果组装
- 子进程只负责构造受限 globals 并执行 `exec(code, globals_dict)`
- 主子进程之间通过 `multiprocessing.Pipe` 传递最小 IPC 消息
- `call_tool`、模块导入审批、文件写审批都由子进程发消息给主进程代理完成
- 超时或取消时，主进程会对沙箱子进程执行 `terminate()`，必要时再 `kill()`，确保底层执行体被真正回收
- 审批等待继续复用 `_request_sandbox_approval()`，因此等待用户审批的时间**不计入 timeout**

沙箱内可用：`call_tool(tool_name, args)`, `open(path)`, `request_write_approval(path, reason)`, `path_ops`（安全路径操作）。

`call_tool` 返回工具主内容（不是完整响应壳）。只能调用 `allowed_callers` 包含 `"code_execution"` 的工具；`read_file` / `write_file` / `edit_file` 不再允许在 `execute_code` 中通过 `call_tool` 调用。

代码侧文件访问统一走沙箱内置能力：读取文件直接使用受限 `open()`；写入文件先调用 `request_write_approval()`，获批后再使用 `open()` 写入。路径仍受 `resolve_managed_path(..., caller='code_execution')` 的受管边界约束。

白名单模块：math, json, re, csv, datetime, collections, itertools, functools, statistics, time, io, string, decimal, operator, copy, textwrap, hashlib, base64, struct。

允许按需导入：ast（用于 `ast.literal_eval` 解析 Python 字面量）。

禁止导入：os, sys, subprocess, shutil, socket。路径操作使用 `path_ops` 替代。

`path_ops` 提供 `join`, `basename`, `dirname`, `splitext`, `exists`, `isfile`, `isdir`, `abspath`, `normpath`，替代被禁的 `os.path`。

### Bash 工具（bash_tool.py）

`execute_bash(command, working_dir, working_dir_space)` — 受限 bash 命令执行，采用“两段式命令策略”：白名单直通、非白名单审批。

白名单命令（直接执行）：
- 文件搜索与内容查看：grep, find, head, tail, wc, cat, ls, echo, sort, uniq, cut, awk, sed
- 路径与环境：pwd, which, whereis, realpath, dirname, basename
- 文件信息：file, stat, du, df
- 文本处理：tr, tee, xargs, diff, comm, paste, column
- 其他只读：env, printenv, date, uname

所有非白名单命令都会触发一次性审批：
- `execute_bash` 在工具内部发布 `user.approval_required` 事件，复用现有通用审批弹窗
- 审批通过后，仅本次命令放行，不会加入白名单，也不会影响后续调用
- 审批拒绝时返回标准错误结果，metadata 中会带上 `approval_required_commands`
- 管道中任一非白名单命令都会让整条命令进入审批
- 若命中删除、远程下载、解释器 / 子 shell、进程控制、系统控制等高风险命令，审批事件会提升为更明显的风险提示，并附带 `dangerous_command_segments`

`execute_bash` 与 direct 文件工具共享同一套 managed location language：
- 默认工作目录是当前 effective workspace，不再默认指向 `backend-fastapi/`
- 相对 `working_dir` 默认按 workspace 解析
- 可显式使用 `space="workspace|transient|exports"` 指定相对目录根，例如：

```xml
<tool name="execute_bash">
  <command>pwd</command>
  <working_dir space="workspace">.</working_dir>
</tool>
```

```xml
<tool name="execute_bash">
  <command>find . -name '*.json' | head -20</command>
  <working_dir space="transient">.</working_dir>
</tool>
```

```xml
<tool name="execute_bash">
  <command>find . -name '*.md' | wc -l</command>
  <working_dir space="exports">.</working_dir>
</tool>
```

```xml
<tool name="execute_bash">
  <command>cp data.json backup.json</command>
  <working_dir space="workspace">.</working_dir>
</tool>
```

规则说明：
- `space` 仅影响相对 `working_dir` 的解析根
- 绝对 `working_dir` 不受 `space` 改写，仍只做受管边界校验
- `working_dir_space=exports` 需要当前运行上下文提供 `run_id`
- 若使用默认受管目录根（`working_dir` 省略、为空或为 `.`），共享路径层会在需要时自动补建对应的 `workspace/transient/exports` 根目录，避免新会话首次执行时直接报“工作目录不存在”
- 若未提供 `session_id` 且没有可用 `workspace_root`，默认 workspace 解析会返回清晰错误
- 支持管道，支持 `2>/dev/null` 和 `2>&1` 屏蔽 stderr，禁止 `>` `>>` 写重定向
- 管道解析会忽略引号内或被转义的 `|`（如 `grep` 正则中的 `\|`）
- 等待 bash 审批的时间不计入工具超时；命令本体执行超时仍为 30 秒

## 可视化 Artifact 流程

```
方式一：Skill 脚本 artifact 协议（推荐）
  execute_skill_script(skill_name, script_name, arguments, session_id)
    → Skill 脚本执行（子进程，零依赖）
    → stdout JSON 含 artifact 字段
    → _unwrap_script_response 前提取 artifact
    → _handle_artifact 调用 manager.create_chart/create_map/revise 持久化
    → 返回 {artifact_id, viz_type, ...} 给 AI
    → AI 在 final_answer 中插入 [viz:artifact_id]
    → 前端 VisualizationLoader 拉取 GET /api/artifacts/visualizations/{id}
    → MapRenderer / ChartRenderer 渲染

方式二：直接调用 VisualizationArtifactManager（内部基础设施）
  → VisualizationArtifactManager.create_chart/create_map()
  → 生成 artifact_id (viz_xxx)
  → 持久化到 ./data/sessions/<session_id>/visualizations/viz_*.json
  → 索引文件位于 ./data/sessions/<session_id>/visualizations/viz_index.jsonl
```

### Artifact 协议格式

Skill 脚本输出 JSON 到 stdout，当需要创建可视化 artifact 时，包含 `artifact` 字段：

```json
{
  "success": true,
  "data": { "...业务数据..." },
  "artifact": {
    "viz_type": "chart|map",
    "sub_type": "bar|line|heatmap|marker|...",
    "title": "图表标题",
    "config": { "...ECharts option 或 map_data..." }
  }
}
```

修改已有 artifact 时使用 `action: "revise"`：

```json
{
  "success": true,
  "data": { "..." },
  "artifact": {
    "action": "revise",
    "artifact_id": "viz_xxx",
    "config": { "...配置补丁..." },
    "replace": false
  }
}
```

## 结果引用系统（refs/result_references.py）

| 函数 | 说明 |
|------|------|
| `materialize_result_reference(result)` | ToolExecutionResult → 可序列化字典 |
| `resolve_result_path(result, json_path, ...)` | 解析点号路径 `content.layers.0`，失败返回 `make_ref_error()` |
| `result_primary_content(result)` | 提取主内容（content 字段） |
| `stringify_result_value(value)` | 序列化为文本 |
| `result_success(result)` | 提取成功标志 |
| `result_event_payload(result)` | 事件总线用的 JSON 对象 |
| `make_ref_error(reason, placeholder, available_keys)` | 构造路径解析错误标记 |
| `is_ref_error(value)` | 判断值是否为错误标记 |
| `detect_unresolved_placeholders(arguments)` | 扫描参数中残留的未替换占位符 |

路径解析失败时返回错误标记（含可用 keys），Agent 在 observation 中看到明确错误信息可重试。
工具执行前（`base.py._handle_actions`）拦截未替换占位符，跳过执行并返回错误提示。

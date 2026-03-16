# 工具系统

> 变更工具代码后请同步更新本文档。

## 目录结构

```
tools/
├── catalog/                          # 工具定义层
│   ├── static_tools.py               # 静态工具契约（create_chart, create_map 等）
│   ├── skill_tools.py                # Skill 工具契约
│   ├── document_tools.py             # 文档工具契约
│   ├── agent_tools.py                # Agent 委托工具
│   ├── builtin_tools.py              # 内置工具（request_user_input）
│   └── mcp_tools.py                  # MCP 工具适配
├── tool_executor_modules/            # 工具实现层
│   ├── dispatcher.py                 # 分发入口 + TOOL_HANDLERS + _merge_decorated_handlers()
│   ├── visualization_tools.py        # 可视化（图表、地图）
│   ├── emergency_tools.py            # 应急决策
│   ├── report_tools.py               # 应急报告生成（@tool 装饰器示范）
│   ├── skill_tools.py                # Skill 执行
│   ├── shared.py                     # 共享依赖
│   └── __init__.py                   # 导出 + __all__
├── tool_registry.py                  # ToolRegistry 注册表
├── tool_definition_builder.py        # ToolContract → OpenAI 格式
├── tool_executor.py                  # 执行公共入口
├── permissions.py                    # 权限管理 + TOOL_PERMISSIONS + _merge_decorated_permissions()
├── result_schema.py                  # ToolExecutionResult 数据模型
├── response_builder.py              # success_result() / error_result()
├── result_references.py             # 占位符路径解析 + 错误标记 + 未替换检测
├── result_normalizer.py             # 结果规范化
├── decorators.py                    # @tool() 装饰器（合并 Contract+Permission+Handler）
├── auto_discovery.py                # 自动扫描装饰器注册的工具
├── consistency_check.py             # 工具注册一致性校验
├── code_sandbox.py                  # Python 代码沙箱
├── document_executor.py             # 文档处理
├── visualization_artifact_manager.py # 可视化 artifact 持久化
└── visualization_fallback.py        # 可视化降级
```

## 新增工具注册

### 方式一：@tool() 装饰器（推荐，所有业务工具已迁移至此方式）

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
)
def my_tool(arguments, **kwargs):
    ...
```

启动时自动发现（`auto_discovery.py`）→ 合并到 TOOL_HANDLERS/TOOL_PERMISSIONS → Contract 注入 ToolRegistry → 一致性校验（`consistency_check.py`）。

已迁移的工具（14 个）：
- `visualization_tools.py`: create_chart, create_map, create_bindmap, revise_visualization
- `emergency_tools.py`: query_emergency_plan, assess_flood_risk, match_emergency_response, create_risk_map
- `report_tools.py`: generate_report
- `skill_tools.py`: activate_skill, load_skill_resource, execute_skill_script, get_skill_info
- `code_sandbox.py`: execute_code

### 方式二：手动注册链路（扩展保留，当前无工具使用）

所有业务工具已迁移到 @tool() 装饰器，手动注册链路仅作为扩展机制保留。

1. **实现函数** → `tool_executor_modules/<module>.py`
2. **定义契约** → `catalog/static_tools.py`
3. **配置权限** → `permissions.py`

完成后更新本文档的「工具清单」章节。

## 执行流程

```
execute_tool(tool_name, arguments, agent_config, event_bus, user_role, caller, session_id)
  ├─ _request_user_approval_if_needed()
  │   ├─ check_tool_permission()  → (allowed, error_msg)
  │   └─ 如果 requires_approval → 发布事件等待用户确认
  ├─ 获取 timeout_seconds（来自 ToolPermission，默认 60s）
  ├─ 分发（TOOL_HANDLERS / DOCUMENT_TOOL 分支经 _run_with_timeout 包装）
  │   ├─ tool_name in TOOL_HANDLERS → _run_with_timeout(handler, timeout)（自动注入上下文参数）
  │   ├─ tool_name in DOCUMENT_TOOL_NAMES → _run_with_timeout(_execute_document_tool, timeout)
  │   ├─ is_mcp_tool(tool_name) → _execute_mcp_tool()（自带超时，不包装）
  │   └─ else → error_result()
  ├─ _normalize_tool_result() → 统一为 ToolExecutionResult
  └─ 返回 ToolExecutionResult
```

## 核心数据模型

### ToolExecutionResult（result_schema.py）

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

### ToolContract（tool_definition_builder.py）

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
    source: str                      # static/skill/document/agent/mcp
```

### 权限配置（permissions.py）

```python
class ToolPermission:
    tool_name: str
    risk_level: RiskLevel            # LOW / MEDIUM / HIGH
    requires_approval: bool          # 是否需要用户审批
    description: str
    allowed_roles: list              # 空=所有角色
    allowed_callers: list            # direct / code_execution
    timeout_seconds: int             # 执行超时秒数（默认 60，0=不限制）
```

慢工具超时配置：`execute_skill_script`、`extract_structured_data`、`generate_report` 设为 120s。

### 结果规范化（dispatcher._normalize_tool_result）

dispatcher 在返回结果前统一规范化，确保调用方始终拿到 `ToolExecutionResult`：

| 工具返回值 | 规范化行为 |
|-----------|-----------|
| `ToolExecutionResult` | 直接返回 |
| `None` | `error_result("工具返回了空结果")` |
| `dict` | `success_result(content=result)` |
| 其他类型 | `success_result(content=str(result))` |

## 工具清单

### 可视化工具（visualization_tools.py）

| 函数 | 参数 | 说明 |
|------|------|------|
| `create_chart` | data, chart_type, title, x_field, y_field, series_field, session_id | 生成 ECharts 图表 |
| `create_map` | data, map_type, title, name_field, value_field, geometry_field, marker_style, session_id | 生成 Leaflet 地图 |
| `create_bindmap` | layers, title, session_id | 多图层叠加地图 |
| `revise_visualization` | artifact_id, config_patch, replace | 修改已有可视化 |

内部辅助：`_parse_geometry()`, `_compute_centroid()`, `_process_map_layer()`, `_load_dataframe()`, `_normalize_marker_style()`

map_type 支持：heatmap / marker / circle / choropleth / geojson / bindmap / risk

marker_style.icon 支持（共 25 种）：
- 基础形状：pin / dot / ring / square / diamond / triangle / star / flag / badge
- 应急场景：hospital（医院）/ shelter（避难所）/ station（水文站）/ warning（警告）/ rescue（救援）/ supply（物资）
- 基础设施：school（学校）/ bridge（桥梁）/ dam（大坝）/ reservoir（水库）/ pump（泵站）
- 通用形状：cross（十字）/ hexagon（六边形）/ arrow（箭头）/ shield（盾牌）/ drop（水滴）

marker_style 为全局默认样式；若数据行包含 `icon` 字段（值为上述图标名），则该行使用行级图标覆盖全局设置。

data 参数接受：JSON 字符串、文件路径、列表/字典、占位符引用

geometry 参数接受：WKT POINT `POINT (108.32 22.82)` 或 GeoJSON dict/string

### 应急工具（emergency_tools.py）

| 函数 | 参数 | 说明 |
|------|------|------|
| `query_emergency_plan` | query, plan_type, top_k | 查询应急预案 |
| `assess_flood_risk` | location, rainfall_24h, water_level, warning_level, forecast_rainfall | 洪涝风险评估 |
| `match_emergency_response` | risk_level, disaster_type, affected_area | 匹配应急响应方案 |
| `create_risk_map` | locations_data, title, disaster_type, session_id | 批量风险评估+地图 |

风险等级阈值：I(特别重大/250mm) → II(重大/200mm) → III(较大/100mm) → IV(一般/50mm)

### 报告工具（report_tools.py）

| 函数 | 参数 | 说明 |
|------|------|------|
| `generate_report` | report_type, title, location, situation_data, risk_data, warning_data, plan_data, action_data, weather_data, extra_sections, report_time | 生成标准格式应急报告 |

报告类型：flood_bulletin（汛情快报）、disaster_report（灾情报告）、situation_report（综合态势报告）

各数据参数接受 JSON 字符串，未提供的章节标注"暂无数据"。返回 output_type=markdown。

### Skill 工具（skill_tools.py）

| 函数 | 参数 | 说明 |
|------|------|------|
| `activate_skill` | skill_name | 激活 Skill，加载 SKILL.md |
| `load_skill_resource` | skill_name, resource_file | 加载 Skill 资源文件 |
| `execute_skill_script` | skill_name, script_name, arguments | 执行 Skill 脚本 |
| `get_skill_info` | skill_name | 获取 Skill 元信息 |

### 文档工具（document_executor.py）

| 函数 | 参数 | 说明 |
|------|------|------|
| `read_document` | file_path, encoding | 读取 PDF/Word/TXT/Markdown |
| `chunk_document` | content, chunk_size, chunk_overlap, strategy | 文档分块 |
| `extract_structured_data` | text, schema, instruction, examples | 结构化数据提取 |
| `preview_data_structure` | file_path | 预览文件数据结构 |
| `write_file` | content, file_path, encoding | 写文件 |
| `read_file` | file_path, encoding, offset, limit | 读文件（分页） |
| `edit_file` | file_path, old_text, new_text, encoding | 编辑文件 |

### 代码沙箱（code_sandbox.py）

`execute_code_sandbox(code, description, timeout, ...)` — 受限 Python 执行环境

沙箱内可用：`call_tool(tool_name, args)`, `open(path)`, `request_write_approval(path, reason)`

白名单模块：math, json, re, csv, datetime, collections, itertools, functools, statistics

## 可视化 Artifact 流程

```
create_chart/create_map 工具
  → VisualizationArtifactManager.create_chart/create_map()
  → 生成 artifact_id (viz_xxx)
  → 持久化到 ./static/temp_data/viz_*.json
  → 返回 artifact_id
  → Agent 在 final_answer 中插入 [viz:artifact_id]
  → 前端 VisualizationLoader 拉取 GET /api/artifacts/visualizations/{id}
  → MapRenderer / ChartRenderer 渲染
```

## 结果引用系统（result_references.py）

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

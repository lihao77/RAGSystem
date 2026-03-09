# 工具系统

`backend/tools/` 定义 Agent 可调用的工具、执行器和权限控制。

## 核心文件

- `function_definitions.py`：工具声明
- `tool_executor.py`：工具执行入口
- `permissions.py`：风险等级、审批和启用检查
- `tool_executor_modules/`：按主题拆分的执行逻辑
- `document_tools.py` / `document_executor.py`：文档处理类工具
- `code_sandbox.py`：受限代码执行

## 当前工具类别

- 图谱查询：`query_knowledge_graph_with_nl`、`search_knowledge_graph`、`get_entity_relations`
- 图谱分析：`analyze_temporal_pattern`、`find_causal_chain`、`compare_entities`
- 统计与可视化：`aggregate_statistics`、`generate_chart`、`generate_map`
- 数据处理：`process_data_file`、`transform_data`、`execute_code`
- 文档处理：`read_document`、`chunk_document`、`extract_structured_data`
- Skills 系统工具：由 AgentLoader 在启用 Skill 时追加
- MCP 工具：运行时根据 MCP Server 动态注册

## 权限模型

权限定义位于 `permissions.py`：

- `LOW`：只读
- `MEDIUM`：可能耗时或返回大量数据
- `HIGH`：写操作、删除操作、外部脚本或高风险执行

当前行为：

- 是否允许调用，先检查工具是否在 Agent 配置中启用
- 高风险工具可要求用户审批
- 审批响应接口在 `/api/agent/sessions/<session_id>/approvals/<approval_id>/respond`

## 与 Agent 的关系

- Agent 可用工具列表由 `backend/agents/config/loader.py` 组装
- Skills 和 MCP 工具不会直接写在 `function_definitions.py` 里，而是运行时注入

## 验证

- 通过聊天页触发工具调用
- 查看对话端审批交互
- 查看 `backend/routes/agent_api/stream_control.py`

# Agent 系统

当前 Agent 子系统由配置管理、动态加载器、`ReActAgent`、`MasterAgentV2`、事件总线、监控和 Skills 组成。

## 目录

- `config/`：`AgentConfig`、`AgentConfigManager`、`AgentLoader`
- `configs/`：`agent_configs.yaml` 及示例文件
- `core/`：基础模型、上下文、注册表、编排器
- `implementations/react/`：`ReActAgent`
- `implementations/master/`：`MasterAgentV2`
- `context/`：上下文预算、压缩和 token 统计
- `events/`：事件总线、发布器、SSE 适配
- `monitoring/`：指标收集
- `skills/`：Skill 加载与运行环境
- `streaming/`：流式响应相关工具

## 当前加载行为

- 用户 Agent 从 `configs/agent_configs.yaml` 读取
- `config/loader.py` 根据 `custom_params.type` 选择 Agent 类，当前内置类型为 `react`
- `master_agent_v2` 作为系统 Agent 始终装载
- 如果 `agent_configs.yaml` 中存在 `master_agent_v2`，系统会优先复用其中配置字段
- 工具、Skills 和 MCP 工具由 `AgentLoader._resolve_tools_and_skills()` 统一过滤和注入

## 主要接口

- `GET /api/agent/agents`
- `POST /api/agent/execute`
- `POST /api/agent/execute/<agent_name>`
- `POST /api/agent/stream`
- `POST /api/agent/stream/stop`
- `POST /api/agent/stream/reconnect`
- `GET /api/agent/execution/overview`
- `GET /api/agent/metrics`
- `POST /api/agent/metrics/reset`
- `GET /api/agent/context-snapshot`
- `POST /api/agent/sessions/<session_id>/approvals/<approval_id>/respond`
- `POST /api/agent/sessions/<session_id>/inputs/<input_id>/respond`

## 相关文件

- `config/loader.py`
- `config/manager.py`
- `config/models.py`
- `implementations/react/agent.py`
- `implementations/master/agent.py`
- `events/bus.py`
- `monitoring/metrics_collector.py`

## 配置入口

- `configs/agent_configs.yaml.example`
- `../model_adapter/configs/providers.yaml.example`
- `../mcp/configs/mcp_servers.yaml.example`

## 辅助文档

- `configs/README.md`
- `skills/README.md`
- `docs/README.md`

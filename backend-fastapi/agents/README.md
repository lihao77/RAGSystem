# Agent 系统

当前 Agent 子系统是后端主链的核心。

## 组成

- `config/`
  - Agent 配置模型、配置管理、加载器
- `configs/`
  - `agent_configs.yaml` 及示例
- `core/`
  - Agent 基础模型、注册表、编排器
- `implementations/react/`
  - `ReActAgent`
- `implementations/master/`
  - `MasterAgentV2`
- `context/`
  - 上下文预算、压缩和 token 管理
- `events/`
  - 事件总线、SSE 适配、会话事件管理
- `monitoring/`
  - 指标与监控
- `skills/`
  - Skill 加载、隔离环境与运行支持
- `streaming/`
  - 工具 XML 解析、流式执行辅助

## 当前行为

- 用户 Agent 从 `configs/agent_configs.yaml` 加载
- `master_agent_v2` 作为系统 Agent 始终装载
- Agent 可用工具由 `AgentLoader` 统一组装
- 默认工具定义来自 `backend/tools/catalog/`，统一通过 `backend/tools/tool_registry.py` 暴露
- MCP 工具和 Skills 系统工具在运行时注入

## 主要接口

- `GET /api/agent/agents`
- `POST /api/agent/execute`
- `POST /api/agent/execute/<agent_name>`
- `POST /api/agent/stream`
- `POST /api/agent/stream/stop`
- `POST /api/agent/stream/reconnect`
- `GET /api/agent/execution/overview`
- `POST /api/agent/sessions/<session_id>/approvals/<approval_id>/respond`
- `POST /api/agent/sessions/<session_id>/inputs/<input_id>/respond`

## 相关文档

- [configs/README.md](configs/README.md)
- [skills/README.md](skills/README.md)

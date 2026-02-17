# Agent 系统文档

## 文档结构

- **architecture/** — 架构设计
  - [SYSTEM_DESIGN.md](architecture/SYSTEM_DESIGN.md) — 系统设计
  - [UNIFIED_ENTRY.md](architecture/UNIFIED_ENTRY.md) — 统一入口架构
  - [MULTI_AGENT_SUMMARY.md](architecture/MULTI_AGENT_SUMMARY.md) — 多智能体架构总结

- **guides/** — 使用指南
  - [CONFIGURATION.md](guides/CONFIGURATION.md) — 配置指南
  - [PLUGIN_DEVELOPMENT.md](guides/PLUGIN_DEVELOPMENT.md) — 插件开发
  - [MASTER_AGENT_USAGE.md](guides/MASTER_AGENT_USAGE.md) — Master Agent 使用
  - [USAGE_GUIDE.md](guides/USAGE_GUIDE.md) — 使用指南

- **advanced/** — 高级主题
  - [CONTEXT_MANAGEMENT.md](advanced/CONTEXT_MANAGEMENT.md) — 智能上下文管理
  - [MASTER_CONTEXT_CONFIG.md](advanced/MASTER_CONTEXT_CONFIG.md) — Master 上下文配置

- **event-bus/** — 事件总线
  - [SESSION_EVENT_BUS_GUIDE.md](event-bus/SESSION_EVENT_BUS_GUIDE.md)
  - [EVENT_BUS_INTEGRATION_GUIDE.md](event-bus/EVENT_BUS_INTEGRATION_GUIDE.md)

## 代码结构（重组后）

```
agents/
├── core/           # 核心：BaseAgent, AgentContext, Registry, Orchestrator
├── implementations/# 实现：ReActAgent, MasterAgentV2
├── config/         # 配置：AgentConfig, AgentConfigManager, AgentLoader
├── context/        # 上下文管理：ContextManager
├── events/         # 事件：EventBus, EventPublisher, SSEAdapter
└── skills/         # Skills 系统
```

导入示例：`from agents import get_orchestrator`，`from agents.events import get_session_event_bus`，`from agents.config import get_config_manager`。

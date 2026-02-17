# 事件总线系统 - 完整文档索引

本目录包含事件总线系统的文档，实现代码位于 `backend/agents/`。

---

## 📁 文件清单

### 核心实现（代码位置）

| 文件 | 说明 |
|------|------|
| `../../event_bus.py` | 事件总线核心：发布/订阅、用户许可、事件持久化 |
| `../../event_publisher.py` | 事件发布器：简化 Agent 发布事件的 API |
| `../../sse_adapter.py` | SSE 适配器：将事件总线桥接到前端 |
| `../../session_event_bus_manager.py` | **会话级事件总线管理器**：每个对话独立的事件总线 |

### 文档（本目录）

| 文件 | 说明 |
|------|------|
| [EVENT_BUS_INTEGRATION_GUIDE.md](EVENT_BUS_INTEGRATION_GUIDE.md) | 集成指南：如何在 MasterAgent V2 中使用 |
| [SESSION_EVENT_BUS_GUIDE.md](SESSION_EVENT_BUS_GUIDE.md) | **会话级事件总线指南**：每个对话独立事件流 |

### 测试

| 文件 | 说明 |
|------|------|
| `../../../test_event_bus.py` | 基础事件总线测试套件 |
| `../../../test_session_event_bus.py` | 会话级事件总线测试 |

---

## 🚀 快速开始

### 推荐：会话级事件总线

```python
from agents.events import get_session_event_bus, EventPublisher, EventType

event_bus = get_session_event_bus(session_id="abc123")

def my_handler(event):
    print(f"收到事件: {event.type.value}")

event_bus.subscribe(
    event_types=[EventType.THOUGHT, EventType.FINAL_ANSWER],
    handler=my_handler
)

publisher = EventPublisher(
    agent_name="my_agent",
    session_id="abc123",
    event_bus=event_bus
)
publisher.thought("我在思考...")
publisher.final_answer("答案是42")
```

详见 [SESSION_EVENT_BUS_GUIDE.md](SESSION_EVENT_BUS_GUIDE.md)。

---

## 📚 文档导航

1. **快速集成** → [EVENT_BUS_INTEGRATION_GUIDE.md](EVENT_BUS_INTEGRATION_GUIDE.md)  
   - 如何在 MasterAgent V2 中使用、代码示例、迁移清单

2. **会话级事件流** → [SESSION_EVENT_BUS_GUIDE.md](SESSION_EVENT_BUS_GUIDE.md)  
   - 每个对话独立事件流、配置与生命周期

---

**维护者**: RAGSystem Team

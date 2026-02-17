# 会话级事件总线 - 使用指南

本文档说明如何使用会话级事件总线管理器，为每个对话维护独立的事件流。

---

## 核心概念

### 改进前：全局单例事件总线

```python
# 所有会话共享一个事件总线
event_bus = get_event_bus()  # 全局单例

# 问题：
# 1. 不同会话的事件混在一起
# 2. 需要手动过滤 session_id
# 3. 并发时可能有性能问题
```

### 改进后：会话级事件总线

```python
# 每个会话有独立的事件总线实例
event_bus = get_session_event_bus(session_id="abc123")

# 优势：
# 1. 完全隔离，不同会话互不干扰
# 2. 无需过滤 session_id
# 3. 会话结束时自动清理
```

---

## 快速开始

### 1. 基础使用

```python
from agents.events import get_session_event_bus, EventPublisher

# 在 Agent 执行时
def execute(self, task: str, context: AgentContext):
    session_id = context.session_id

    # 获取该会话的事件总线
    event_bus = get_session_event_bus(session_id)

    # 创建事件发布器
    publisher = EventPublisher(
        agent_name=self.name,
        session_id=session_id,
        event_bus=event_bus  # 使用会话级事件总线
    )

    # 发布事件
    publisher.agent_start(task)
    publisher.thought("开始分析任务...")
    # ...
```

### 2. 在 Flask 路由中使用

```python
# routes/agent.py
from agents.events import get_session_event_bus, cleanup_session, SSEAdapter

@agent_bp.route('/stream', methods=['POST'])
async def stream_execute():
    data = request.get_json()
    task = data.get('task')
    session_id = data.get('session_id') or str(uuid.uuid4())

    # ✨ 获取会话的事件总线（自动创建）
    event_bus = get_session_event_bus(session_id)

    async def generate():
        try:
            # 创建 SSE 适配器
            adapter = SSEAdapter(event_bus=event_bus, session_id=session_id)

            # 在后台执行 Agent 任务
            async def execute_task():
                orchestrator = _get_orchestrator()
                context = AgentContext(session_id=session_id)
                await orchestrator.execute_async(task, context)

            # 启动任务
            asyncio.create_task(execute_task())

            # 流式输出事件
            async for sse_data in adapter.stream():
                yield sse_data

        finally:
            # ✨ 会话结束时清理（可选，也可以依赖自动清理）
            # cleanup_session(session_id)
            pass

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream'
    )
```

### 3. 会话生命周期管理

```python
from agents.events import (
    get_session_event_bus,
    cleanup_session,
    touch_session
)

# 1. 会话开始：获取事件总线
event_bus = get_session_event_bus(session_id="abc123")

# 2. 会话活跃：保持会话活跃（防止被自动清理）
touch_session(session_id="abc123")

# 3. 会话结束：手动清理
cleanup_session(session_id="abc123")

# 注意：如果不手动清理，系统会在 TTL 过期后自动清理
```

---

## 配置选项

### 管理器配置

```python
from agents.events import SessionEventBusManager

# 自定义配置
manager = SessionEventBusManager(
    session_ttl=3600,           # 会话过期时间（秒），默认1小时
    cleanup_interval=300,       # 自动清理间隔（秒），默认5分钟
    enable_persistence=True     # 是否启用事件持久化
)

# 获取会话事件总线
event_bus = manager.get_or_create(session_id="abc123")
```

### 全局管理器配置

```python
from agents.events import get_session_manager

# 配置全局管理器（首次调用时生效）
manager = get_session_manager(
    session_ttl=7200,           # 2小时
    cleanup_interval=600,       # 10分钟清理一次
    enable_persistence=True
)
```

---

## 高级用法

### 1. 会话统计

```python
from agents.events import get_session_manager

manager = get_session_manager()

# 获取单个会话的统计
stats = manager.get_session_stats(session_id="abc123")
print(stats)
# {
#     "session_id": "abc123",
#     "total_events": 234,
#     "events_by_type": {...},
#     "last_activity": 1234567890.0,
#     "age_seconds": 123.45,
#     ...
# }

# 获取所有会话的统计
all_stats = manager.get_all_stats()
for session_id, stats in all_stats.items():
    print(f"会话 {session_id}: {stats['total_events']} 个事件")
```

### 2. 查看活跃会话

```python
manager = get_session_manager()

# 获取所有活跃会话
active_sessions = manager.get_active_sessions()
print(f"当前活跃会话: {len(active_sessions)} 个")
print(active_sessions)
# ['session1', 'session2', 'session3']
```

### 3. 手动清理过期会话

```python
manager = get_session_manager()

# 手动触发清理（通常不需要，系统会自动清理）
manager._cleanup_expired_sessions()
```

### 4. 会话重连

```python
# 场景：用户刷新页面，但会话ID相同

# 前端重新连接
session_id = "abc123"  # 从 localStorage 读取

# 后端获取现有事件总线（如果存在）
event_bus = get_session_event_bus(session_id)

# 如果会话还在 TTL 内，会复用现有的事件总线
# 用户可以看到之前的事件历史
history = event_bus.get_event_history(session_id=session_id, limit=100)
```

---

## 与 MasterAgent V2 集成

### 修改 1: 使用会话级事件总线

```python
# backend/agents/master_agent_v2/master_v2.py

from agents.events import get_session_event_bus, EventPublisher

class MasterAgentV2(BaseAgent):
    def execute_stream(self, task: str, context: AgentContext):
        """流式执行任务"""

        # ✨ 获取会话的事件总线
        event_bus = get_session_event_bus(context.session_id)

        # 创建事件发布器
        self._publisher = EventPublisher(
            agent_name=self.name,
            session_id=context.session_id,
            trace_id=context.metadata.get('trace_id'),
            event_bus=event_bus  # ✨ 使用会话级事件总线
        )

        # 发布事件
        self._publisher.session_start(metadata={"task": task})
        self._publisher.agent_start(task)

        # ... 执行逻辑 ...

        self._publisher.agent_end(result)
        self._publisher.session_end()

        return AgentResponse(success=True, content=result)
```

### 修改 2: 在路由中清理会话

```python
# routes/agent.py

from agents.events import cleanup_session

@agent_bp.route('/stream', methods=['POST'])
async def stream_execute():
    # ...

    async def generate():
        try:
            # 执行 Agent
            async for sse_data in adapter.stream():
                yield sse_data

        finally:
            # ✨ 会话结束时清理（可选）
            # 如果不清理，系统会在 TTL 过期后自动清理
            cleanup_session(session_id)

    return Response(...)
```

### 修改 3: 保持长会话活跃

```python
# 如果会话可能持续很久（超过 TTL）

from agents.events import touch_session

async def long_running_task(session_id):
    while not done:
        # 执行任务
        await do_something()

        # ✨ 定期保持会话活跃
        touch_session(session_id)
        await asyncio.sleep(60)  # 每分钟一次
```

---

## 性能优化

### 1. 调整 TTL

```python
# 短期会话（如快速查询）
manager = SessionEventBusManager(session_ttl=600)  # 10分钟

# 长期会话（如复杂分析）
manager = SessionEventBusManager(session_ttl=7200)  # 2小时
```

### 2. 调整清理间隔

```python
# 高频清理（内存敏感场景）
manager = SessionEventBusManager(cleanup_interval=60)  # 1分钟

# 低频清理（性能优先）
manager = SessionEventBusManager(cleanup_interval=600)  # 10分钟
```

### 3. 禁用持久化（降低内存）

```python
# 不需要事件历史时，禁用持久化
manager = SessionEventBusManager(enable_persistence=False)
```

---

## 监控与调试

### 1. 监控活跃会话数

```python
from agents.events import get_session_manager

@app.route('/api/admin/sessions/stats')
def sessions_stats():
    manager = get_session_manager()

    active_sessions = manager.get_active_sessions()
    all_stats = manager.get_all_stats()

    return {
        "active_count": len(active_sessions),
        "sessions": all_stats
    }
```

### 2. 调试会话事件

```python
# 查看某个会话的所有事件
event_bus = get_session_event_bus(session_id="abc123")
history = event_bus.get_event_history(limit=100)

for event in history:
    print(f"[{event.type.value}] {event.data}")
```

### 3. 日志级别

```python
import logging

# 开启调试日志
logging.getLogger('agents.session_event_bus_manager').setLevel(logging.DEBUG)

# 日志输出示例：
# [INFO] SessionEventBusManager 初始化 (TTL: 3600s, 清理间隔: 300s)
# [INFO] ✨ 创建会话事件总线: abc123
# [DEBUG] 复用现有事件总线: abc123
# [INFO] 🗑️ 移除会话事件总线: xyz789
# [INFO] 🕒 清理过期会话: old-session (闲置 61.2 分钟)
```

---

## 常见问题

### Q1: 会话什么时候被清理？

A: 有两种情况：
1. **手动清理**: 调用 `cleanup_session(session_id)`
2. **自动清理**: 会话闲置超过 `session_ttl` 后，清理线程会自动移除

### Q2: 如何防止长会话被清理？

A: 定期调用 `touch_session(session_id)` 更新活跃时间。

### Q3: 会话清理后，用户重连怎么办？

A: 会创建新的事件总线实例，事件历史丢失。如需保留历史，应：
- 延长 `session_ttl`
- 或将事件持久化到数据库

### Q4: 内存占用如何？

A: 每个会话的事件总线约占用：
- 无持久化：~1MB
- 有持久化（1000条事件）：~3MB

### Q5: 是否线程安全？

A: 是的，内部使用 `threading.RLock()` 保证线程安全。

---

## 迁移清单

### 从全局事件总线迁移到会话级

- [ ] **第1步**: 安装会话管理器
  - [x] 创建 `session_event_bus_manager.py`

- [ ] **第2步**: 修改 Agent
  - [ ] 在 MasterAgent V2 中使用 `get_session_event_bus()`
  - [ ] 在子 Agent 中使用会话级事件总线

- [ ] **第3步**: 修改 Flask 路由
  - [ ] 在 `/api/agent/stream` 中使用会话级事件总线
  - [ ] 可选：在会话结束时调用 `cleanup_session()`

- [ ] **第4步**: 测试
  - [ ] 测试多会话并发
  - [ ] 测试会话清理
  - [ ] 测试会话重连

- [ ] **第5步**: 监控
  - [ ] 添加会话统计端点
  - [ ] 监控活跃会话数量
  - [ ] 监控内存使用

---

## 总结

会话级事件总线提供：
- ✅ **完全隔离** - 每个对话有独立的事件流
- ✅ **自动清理** - 过期会话自动移除，避免内存泄漏
- ✅ **线程安全** - 支持多会话并发
- ✅ **易于使用** - 简洁的API，一行代码获取事件总线
- ✅ **可监控** - 完整的统计和调试接口

**推荐立即使用**，特别适合多用户并发场景！

---

**文档版本**: 1.0
**创建日期**: 2026-02-11

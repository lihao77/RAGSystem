# 调用树重构文档

## 概述

本次重构为事件系统添加了 `call_id` 和 `parent_call_id` 字段，使得每个事件天然携带调用链信息，便于构建完整的调用树。

## 重构目标

1. **自动携带调用链信息**：每个事件自动包含 `call_id`（当前节点ID）和 `parent_call_id`（父节点ID）
2. **简化调用树构建**：前端可以直接通过 `parent_call_id` 建立父子关系，无需复杂的推断逻辑
3. **支持多层嵌套**：支持 Agent 调用 Agent、Agent 调用 Tool 等多层嵌套场景
4. **提升可观测性**：完整的调用链信息便于追踪和调试

## 核心变更

### 1. 事件数据结构（`backend/agents/events/bus.py`）

在 `Event` 数据类中添加了两个新字段：

```python
@dataclass
class Event:
    # ... 其他字段 ...

    # 调用链信息（用于构建调用树）
    call_id: Optional[str] = None          # 当前调用节点的ID
    parent_call_id: Optional[str] = None   # 父调用节点的ID

    def to_dict(self) -> Dict[str, Any]:
        return {
            # ... 其他字段 ...
            "call_id": self.call_id,
            "parent_call_id": self.parent_call_id,
            # ... 其他字段 ...
        }
```

### 2. 事件发布器（`backend/agents/events/publisher.py`）

#### 2.1 初始化参数

`EventPublisher` 初始化时接收 `call_id` 和 `parent_call_id`：

```python
def __init__(
    self,
    agent_name: str,
    session_id: Optional[str] = None,
    trace_id: Optional[str] = None,
    span_id: Optional[str] = None,
    call_id: Optional[str] = None,        # ✨ 新增
    parent_call_id: Optional[str] = None,  # ✨ 新增
    event_bus: Optional[EventBus] = None
):
    self.call_id = call_id
    self.parent_call_id = parent_call_id
    # ...
```

#### 2.2 自动携带调用链信息

`_publish()` 方法自动将 `call_id` 和 `parent_call_id` 添加到所有事件中：

```python
def _publish(
    self,
    event_type: EventType,
    data: Dict[str, Any],
    priority: EventPriority = EventPriority.NORMAL,
    requires_user_action: bool = False,
    user_action_timeout: Optional[float] = None,
    override_call_id: Optional[str] = None,        # ✨ 允许覆盖
    override_parent_call_id: Optional[str] = None  # ✨ 允许覆盖
):
    event = Event(
        type=event_type,
        data=data,
        # ...
        call_id=override_call_id if override_call_id is not None else self.call_id,
        parent_call_id=override_parent_call_id if override_parent_call_id is not None else self.parent_call_id,
        # ...
    )
```

#### 2.3 工具和 Agent 调用事件

`tool_call_start/end` 和 `agent_call_start/end` 方法支持覆盖 `call_id`：

```python
def tool_call_start(
    self,
    call_id: str,
    tool_name: str,
    arguments: Dict,
    parent_call_id: Optional[str] = None
):
    # ✨ 使用 override_call_id 和 override_parent_call_id
    self._publish(
        EventType.CALL_TOOL_START,
        data,
        override_call_id=call_id,
        override_parent_call_id=parent_call_id
    )
```

### 3. 智能体实现

#### 3.1 ReActAgent（`backend/agents/implementations/react/agent.py`）

在初始化 `EventPublisher` 时传递 `call_id` 和 `parent_call_id`：

```python
# 从 context 读取 parent_call_id（如果是被 MasterAgent 调用）
parent_call_id = None
if hasattr(context, 'metadata'):
    parent_call_id = context.metadata.get('parent_call_id')

# 生成当前智能体的 call_id
import uuid
current_call_id = f"call_{uuid.uuid4()}"

self._publisher = EventPublisher(
    agent_name=self.name,
    session_id=current_session_id,
    trace_id=context.metadata.get('trace_id'),
    span_id=context.metadata.get('span_id'),
    call_id=current_call_id,        # ✨ 传递当前调用ID
    parent_call_id=parent_call_id,  # ✨ 传递父调用ID
    event_bus=event_bus
)
```

工具调用时，`parent_call_id` 指向 ReActAgent 的 `call_id`：

```python
# 获取当前 ReActAgent 的 call_id（作为工具调用的 parent_call_id）
agent_call_id = getattr(self, '_current_call_id', None)

self._publisher.tool_call_start(
    call_id=tool_call_id,
    tool_name=data.get('tool_name'),
    arguments=data.get('arguments', {}),
    parent_call_id=agent_call_id  # ✨ 关联到 ReActAgent 的调用
)
```

#### 3.2 MasterAgent（`backend/agents/implementations/master/agent.py`）

MasterAgent 初始化时生成自己的 `call_id`：

```python
# 生成 MasterAgent 自己的 call_id
import uuid
master_call_id = f"call_{uuid.uuid4()}"

# 从 context 获取 parent_call_id（如果 MasterAgent 被其他智能体调用）
parent_call_id = None
if hasattr(context, 'metadata'):
    parent_call_id = context.metadata.get('parent_call_id')

self._publisher = EventPublisher(
    agent_name=self.name,
    session_id=context.session_id,
    trace_id=context.metadata.get('trace_id'),
    span_id=context.metadata.get('span_id'),
    call_id=master_call_id,        # ✨ 传递当前调用ID
    parent_call_id=parent_call_id,  # ✨ 传递父调用ID
    event_bus=event_bus
)
```

调用子智能体时，将 MasterAgent 的 `call_id` 作为子智能体的 `parent_call_id`：

```python
# 发布 AgentCall 开始事件（parent_call_id 指向 MasterAgent 的 call_id）
self._publisher.agent_call_start(
    call_id=call_id,
    agent_name=agent_name,
    description=agent_task,
    parent_call_id=master_call_id,  # ✨ 关联到 MasterAgent 的调用
    order=current_order,
    round=rounds,
    round_index=idx
)

# 将 call_id 传递到子 Agent 的 context（作为 parent_call_id）
child_context.metadata['parent_call_id'] = call_id
```

### 4. 前端调用树构建（`frontend-client/src/views/ChatViewV2.vue`）

重构了 `stepsToSubtasks()` 函数，使用 `call_id` 和 `parent_call_id` 构建调用树：

```javascript
function stepsToSubtasks(steps) {
  // 存储所有调用节点（按 call_id 索引）
  const callNodes = new Map();
  // 存储工具调用（按 call_id 索引）
  const toolCalls = new Map();

  // 第一遍：收集所有节点
  for (const step of steps) {
    const callId = eventData.call_id;
    const parentCallId = eventData.parent_call_id;

    if (eventType === 'call.agent.start') {
      callNodes.set(callId, {
        call_id: callId,
        parent_call_id: parentCallId,
        // ... 其他字段
      });
    }
    // ... 处理其他事件类型
  }

  // 第二遍：将工具调用关联到父 Agent
  for (const [callId, toolCall] of toolCalls.entries()) {
    const parentNode = callNodes.get(toolCall.parent_call_id);
    if (parentNode) {
      parentNode.tool_calls.push(toolCall);
    }
  }

  return { subtasks: Array.from(callNodes.values()), master_steps: [] };
}
```

## 调用链示例

### 示例 1：MasterAgent -> ReActAgent -> Tool

```
MasterAgent (call_abc123)
  └─ ReActAgent (call_def456, parent: call_abc123)
     └─ Tool (tool_ghi789, parent: call_def456)
```

事件流：

1. `CALL_AGENT_START`: call_id=call_abc123, parent_call_id=None
2. `CALL_AGENT_START`: call_id=call_def456, parent_call_id=call_abc123
3. `CALL_TOOL_START`: call_id=tool_ghi789, parent_call_id=call_def456
4. `CALL_TOOL_END`: call_id=tool_ghi789, parent_call_id=call_def456
5. `CALL_AGENT_END`: call_id=call_def456, parent_call_id=call_abc123
6. `CALL_AGENT_END`: call_id=call_abc123, parent_call_id=None

### 示例 2：MasterAgent 并行调用多个 Agent

```
MasterAgent (call_abc123)
  ├─ Agent1 (call_def456, parent: call_abc123)
  │  └─ Tool1 (tool_ghi789, parent: call_def456)
  └─ Agent2 (call_jkl012, parent: call_abc123)
     └─ Tool2 (tool_mno345, parent: call_jkl012)
```

## 测试

可以通过现有前端监控页面和 Agent 流式接口验证调用树构建：

建议结合以下入口：

- `frontend-client/src/views/ChatViewV2.vue`
- `frontend-client/src/components/HierarchicalExecutionTree.vue`
- `POST /api/agent/stream`

## 优势

1. **简化逻辑**：前端无需复杂的推断逻辑，直接通过 `parent_call_id` 建立父子关系
2. **准确性**：调用链信息由后端生成，避免前端推断错误
3. **可扩展性**：支持任意层级的嵌套调用
4. **可观测性**：完整的调用链信息便于追踪和调试
5. **向后兼容**：保留了原有的 `order`、`round` 等字段，不影响现有功能

## 后续优化

1. **前端可视化**：基于调用树实现更直观的可视化展示（树形图、时序图等）
2. **性能分析**：基于调用链分析每个节点的耗时，识别性能瓶颈
3. **错误追踪**：基于调用链快速定位错误发生的位置
4. **调用统计**：统计每个 Agent 和 Tool 的调用次数、成功率等指标

## 相关文件

- `backend/agents/events/bus.py` - 事件数据结构
- `backend/agents/events/publisher.py` - 事件发布器
- `backend/agents/implementations/react/agent.py` - ReActAgent 实现
- `backend/agents/implementations/master/agent.py` - MasterAgent 实现
- `frontend-client/src/views/ChatViewV2.vue` - 前端调用树构建
- `frontend-client/src/components/HierarchicalExecutionTree.vue` - 前端调用树展示组件

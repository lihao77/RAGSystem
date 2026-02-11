# SSE 事件格式迁移指南

## 📋 概述

本文档说明了从**简化格式**到**完整Event对象格式**的SSE事件迁移。

迁移日期：2026-02-12

---

## 🔄 格式变更

### 迁移前（简化格式）

```json
{
  "type": "subtask_start",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829031.003,
  "order": 1,
  "task_id": "v2_agent_1_1",
  "round": 1,
  "subtask_agent": "qa_agent",
  "subtask_description": "查询受灾人口数据"
}
```

**特点**：
- 事件数据扁平化在顶层
- 缺少事件ID、优先级等元数据
- 事件类型为简单字符串

### 迁移后（完整Event对象格式）

```json
{
  "type": "agent.subtask_start",
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1770829031.003,
  "priority": "normal",
  "session_id": "abc123",
  "trace_id": null,
  "span_id": null,
  "agent_name": "master_agent_v2",
  "data": {
    "order": 1,
    "task_id": "v2_agent_1_1",
    "round": 1,
    "subtask_agent": "qa_agent",
    "subtask_description": "查询受灾人口数据"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**特点**：
- 事件数据在 `data` 字段中
- 包含完整的事件元数据（event_id、priority、trace_id、span_id）
- 事件类型使用 EventType 枚举值（如 `agent.subtask_start`）
- 支持用户交互标志（requires_user_action）

---

## 📦 事件类型映射

| 旧类型 | 新类型 | 说明 |
|--------|--------|------|
| `agent_start` | `agent.start` | Agent 开始执行 |
| `agent_end` | `agent.end` | Agent 执行完成 |
| `thought_structured` | `agent.thought_structured` | 结构化思考 |
| `tool_start` | `tool.start` | 工具开始执行 |
| `tool_end` | `tool.end` | 工具执行完成 |
| `tool_error` | `tool.error` | 工具执行错误 |
| `subtask_start` | `subtask.start` | 子任务开始 |
| `subtask_end` | `subtask.end` | 子任务完成 |
| `chunk` | `output.chunk` | 流式输出片段 |
| `final_answer` | `output.final_answer` | 最终答案 |
| `chart_generated` | `visualization.chart` | 图表生成 |
| `map_generated` | `visualization.map` | 地图生成 |
| `error` | `agent.error` | Agent 错误 |
| `session_start` | `agent.session_start` | 会话开始 |
| `session_end` | `agent.session_end` | 会话结束 |

---

## 🔧 后端变更

### 1. SSE_adapter.py

#### 变更前：
```python
def _simplify_event_format(self, event: Event) -> dict:
    """将 Event 对象转换为前端兼容的简单格式"""
    simple_event = {
        "type": "subtask_start",  # 简化的类型名
        "agent_name": event.agent_name,
        "session_id": event.session_id,
        # ... 展开 data 到顶层
    }
    if event.data:
        for key, value in event.data.items():
            if key not in simple_event:
                simple_event[key] = value
    return simple_event
```

#### 变更后：
```python
def _to_full_event_dict(self, event: Event) -> dict:
    """将 Event 对象转换为完整的字典格式（保留所有信息）"""
    return {
        "type": event.type.value,  # 完整的 EventType 枚举值
        "event_id": event.event_id,
        "timestamp": event.timestamp,
        "priority": event.priority.value,
        "session_id": event.session_id,
        "trace_id": event.trace_id,
        "span_id": event.span_id,
        "agent_name": event.agent_name,
        "data": event.data or {},  # 数据保留在 data 字段中
        "requires_user_action": event.requires_user_action,
        "user_action_timeout": event.user_action_timeout
    }
```

#### 关键改动：
1. 方法名从 `_simplify_event_format` 改为 `_to_full_event_dict`
2. 保留完整的事件结构，而不是扁平化
3. 使用 EventType 枚举值作为 type
4. 包含所有元数据字段

### 2. Chunk 流式处理

#### 变更前：
```python
chunk_event = {
    "type": "chunk",
    "content": chunk
}
```

#### 变更后：
```python
chunk_event = {
    "type": EventType.CHUNK.value,  # "output.chunk"
    "event_id": event.event_id,
    "timestamp": time.time(),
    "priority": event.priority.value,
    "session_id": event.session_id,
    "trace_id": event.trace_id,
    "span_id": event.span_id,
    "agent_name": event.agent_name,
    "data": {
        "content": chunk  # 数据在 data 字段中
    },
    "requires_user_action": False,
    "user_action_timeout": None
}
```

---

## 🎨 前端变更

### 1. ChatViewV2.vue

#### 变更前：
```javascript
const data = JSON.parse(line.substring(6));

if (data.type === 'subtask_start') {
  currentMsg.subtasks.push({
    order: data.order,
    task_id: data.task_id,
    round: data.round,
    agent_name: data.agent_name,
    description: data.description,
    // ...
  });
}

else if (data.type === 'chunk') {
  currentMsg.content += data.content;
}
```

#### 变更后：
```javascript
const event = JSON.parse(line.substring(6));

// ✨ 提取事件数据（完整Event对象格式）
const eventData = event.data || {};
const eventType = event.type;

if (eventType === 'agent.subtask_start') {
  currentMsg.subtasks.push({
    order: eventData.order,                   // 从 data 中获取
    task_id: eventData.task_id,               // 从 data 中获取
    round: eventData.round,                   // 从 data 中获取
    agent_name: event.agent_name,             // 从顶层获取
    description: eventData.subtask_description,  // 从 data 中获取
    // ...
  });
}

else if (eventType === 'output.chunk') {
  currentMsg.content += eventData.content;    // 从 data 中获取
}
```

#### 关键改动：
1. 解析后的对象命名从 `data` 改为 `event`
2. 事件特定数据从 `event.data` 提取到 `eventData`
3. 事件类型从 `data.type` 改为 `event.type`
4. 事件类型值使用完整的枚举值（如 `agent.subtask_start`）
5. Agent 名称等元数据从顶层获取（`event.agent_name`）
6. 事件数据从 `eventData` 获取（`eventData.order`）

### 2. 字段访问映射

| 旧访问方式 | 新访问方式 | 说明 |
|-----------|-----------|------|
| `data.type` | `event.type` | 事件类型 |
| `data.agent_name` | `event.agent_name` | Agent 名称（顶层） |
| `data.session_id` | `event.session_id` | 会话ID（顶层） |
| `data.timestamp` | `event.timestamp` | 时间戳（顶层） |
| `data.order` | `event.data.order` | 调用顺序（data中） |
| `data.task_id` | `event.data.task_id` | 任务ID（data中） |
| `data.content` | `event.data.content` | 内容（data中） |
| `data.tool_name` | `event.data.tool_name` | 工具名（data中） |
| - | `event.event_id` | 事件ID（新增） |
| - | `event.priority` | 优先级（新增） |
| - | `event.trace_id` | 追踪ID（新增） |

---

## ✅ 迁移清单

### 后端检查项

- [x] `backend/agents/sse_adapter.py`
  - [x] 替换 `_simplify_event_format` 为 `_to_full_event_dict`
  - [x] 更新 `_format_sse` 方法调用新方法
  - [x] 更新 chunk 流式处理（async 和 sync 版本）
  - [x] 确保所有事件类型使用 EventType 枚举值

- [x] `backend/agents/SSE_EVENT_FORMAT.md`
  - [x] 更新文档反映新格式
  - [x] 添加事件类型映射表
  - [x] 更新所有示例代码

- [x] `backend/agents/TASK_TRACKING_SYSTEM.md`
  - [x] 确保任务追踪文档与新格式一致

### 前端检查项

- [x] `frontend-client/src/views/ChatViewV2.vue`
  - [x] 更新 SSE 解析逻辑
  - [x] 使用 `event.data` 访问事件数据
  - [x] 更新事件类型比较（使用新枚举值）
  - [x] 更新所有字段访问路径

- [ ] `frontend-client/src/views/ChatView.vue`（如果仍在使用）
  - [ ] 同样更新 SSE 解析逻辑

- [ ] 其他组件（如果直接处理 SSE）
  - [ ] 搜索并更新所有 SSE 处理代码

---

## 🧪 测试建议

### 1. 后端测试

```bash
cd backend
python test_event_bus.py
python test_session_event_bus.py
python test_task_tracking_integration.py  # 验证任务追踪
```

### 2. 端到端测试

1. 启动后端服务
2. 启动前端开发服务器
3. 在前端界面发送测试消息
4. 打开浏览器开发者工具 → Network 选项卡
5. 查看 SSE 流数据，验证格式正确：
   ```json
   {
     "type": "agent.subtask_start",
     "event_id": "...",
     "data": { ... }
   }
   ```
6. 在 Console 选项卡验证没有解析错误

### 3. 关键测试场景

- [ ] 简单问候（无子任务调用）
- [ ] 复杂查询（多次子任务调用）
- [ ] 工具调用（验证 task_id 关联）
- [ ] 流式输出（chunk 和 final_answer）
- [ ] 图表生成
- [ ] 错误处理

---

## 📚 相关文档

- `backend/agents/SSE_EVENT_FORMAT.md` - 完整事件格式规范
- `backend/agents/TASK_TRACKING_SYSTEM.md` - 任务追踪系统说明
- `backend/agents/EVENT_BUS_DECOUPLING_COMPLETE.md` - 事件总线解耦说明

---

## ❓ 常见问题

### Q1: 为什么要从简化格式迁移到完整格式？

**A**:
1. **可扩展性**：完整格式保留了所有事件元数据，易于未来扩展
2. **追踪能力**：支持分布式追踪（trace_id、span_id）
3. **用户交互**：支持需要用户确认的操作（requires_user_action）
4. **结构清晰**：事件数据和元数据分离，更易于维护
5. **标准化**：遵循事件溯源（Event Sourcing）模式的最佳实践

### Q2: 旧版前端代码会立即失效吗？

**A**: 是的。由于格式变更是破坏性的（事件类型名称改变，数据结构改变），旧版前端代码需要同步更新。建议：
1. 先更新后端到新格式
2. 立即更新前端解析逻辑
3. 测试所有事件类型

### Q3: 如何调试 SSE 格式问题？

**A**:
1. **浏览器开发者工具**：
   - Network 选项卡 → 找到 `/stream` 请求 → EventStream 标签页
   - 查看原始 SSE 数据

2. **后端日志**：
   - 在 `sse_adapter.py` 的 `_to_full_event_dict` 方法中添加日志
   - 检查发送的事件格式

3. **前端Console**：
   - 在解析代码中添加 `console.log(event)`
   - 检查解析后的事件对象

### Q4: 如何验证任务追踪（task_id）是否正常工作？

**A**:
1. 发送复杂查询（触发多次子任务调用）
2. 在前端 Console 中查看 `task_id` 字段
3. 验证：
   - 每个 `subtask_start` 有唯一的 `task_id`
   - 对应的 `tool_start`/`tool_end` 包含相同的 `task_id`
   - `subtask_end` 包含匹配的 `task_id`

---

**文档版本**: 1.0
**更新时间**: 2026-02-12
**迁移状态**: ✅ 完成

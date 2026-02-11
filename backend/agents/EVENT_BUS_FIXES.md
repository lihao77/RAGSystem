# 事件总线问题修复总结

## 🐛 发现的问题

### 问题 1: 事件格式不兼容
**现象**：前端无法正确接收和解析事件

**原因**：新的事件格式是完整的 Event 对象（包含大量元数据），前端期望的是简化格式

```json
// ❌ 新格式（Event 对象完整序列化）
{
  "event_id": "720da250-bad8-465c-934f-c68ebe9a8169",
  "type": "agent.start",
  "data": {"agent_name": "master_agent_v2", "task": "你好", ...},
  "timestamp": 1770829031.0033877,
  "priority": 1,
  "session_id": "14a546ae-6560-4efa-9a12-475c8e604ce6",
  ...
}

// ✅ 前端期望格式（扁平化）
{
  "type": "agent_start",
  "agent_name": "master_agent_v2",
  "task": "你好"
}
```

### 问题 2: SSE 流不会结束
**现象**：Agent 执行完成后，SSE 连接仍然保持打开，持续发送心跳

**原因**：SSEAdapter 未检测 `session.end` 或 `agent.end` 事件来停止流式输出

### 问题 3: 枚举名称错误
**现象**：`AttributeError: OUTPUT_CHUNK`

**原因**：使用了不存在的枚举名 `EventType.OUTPUT_CHUNK`，正确名称是 `EventType.CHUNK`

---

## ✅ 已应用的修复

### 修复 1: 添加事件格式转换器

**文件**: `backend/agents/sse_adapter.py`

**新增方法**: `_simplify_event_format(event: Event) -> dict`

**功能**：
- 将完整的 Event 对象转换为前端兼容的简化格式
- 映射 EventType 枚举到前端期望的类型名（如 `agent.start` → `agent_start`）
- 展开 `data` 字段到顶层（扁平化结构）
- 确保关键字段（如 `content`）存在

**类型映射表**：
```python
{
    EventType.AGENT_START: "agent_start",
    EventType.AGENT_END: "agent_end",
    EventType.AGENT_ERROR: "error",
    EventType.THOUGHT_STRUCTURED: "thought_structured",
    EventType.TOOL_START: "tool_start",
    EventType.TOOL_END: "tool_end",
    EventType.SUBTASK_START: "subtask_start",
    EventType.SUBTASK_END: "subtask_end",
    EventType.CHUNK: "chunk",
    EventType.FINAL_ANSWER: "final_answer",
    EventType.CHART_GENERATED: "chart_generated",
    EventType.MAP_GENERATED: "map_generated",
    EventType.SESSION_END: "session_end",
}
```

### 修复 2: 自动检测结束事件并停止流

**文件**: `backend/agents/sse_adapter.py`

**修改位置**: `stream()` 和 `stream_sync()` 方法

**逻辑**：
```python
# 检测结束事件，自动停止流
if event.type in [EventType.SESSION_END, EventType.AGENT_END]:
    logger.info(f"[SSEAdapter] 检测到结束事件，停止流式输出")
    break  # 退出循环，停止 SSE 流
```

**触发条件**：
- `EventType.SESSION_END` - 会话结束
- `EventType.AGENT_END` - Agent 执行结束

### 修复 3: 支持流式打字机效果

**文件**: `backend/agents/sse_adapter.py`

**新增参数**：
- `enable_final_answer_streaming: bool = True` - 是否启用 final_answer 流式输出
- `chunk_size: int = 5` - 每个 chunk 的字符数

**功能**：
当 `final_answer` 事件到达时，SSEAdapter 会自动：
1. 将完整答案拆分为小 chunks（每个 5 个字符）
2. 依次发送 chunk 事件（打字机效果）
3. 最后发送完整的 final_answer 事件（包含元数据）

**实现逻辑**：
```python
if event.type == EventType.FINAL_ANSWER and self.enable_final_answer_streaming:
    content = event.data.get("content", "")

    # 拆分为 chunks 流式输出
    for i in range(0, len(content), self.chunk_size):
        chunk = content[i:i + self.chunk_size]
        yield {"type": "chunk", "content": chunk}

    # 最后发送完整的 final_answer
    yield {"type": "final_answer", "content": content, ...}
```

### 修复 4: 修复枚举名称错误

**文件**: `backend/agents/sse_adapter.py`

**修改**：
```python
# ❌ 错误
EventType.OUTPUT_CHUNK: "chunk",

# ✅ 正确
EventType.CHUNK: "chunk",
```

---

## 📊 修复后的事件流

```
前端发起请求
    ↓
Flask Route (/stream)
    ↓
获取会话事件总线
    ↓
创建 SSEAdapter（订阅事件）
    ↓
后台线程执行 Agent
    ↓
Agent 发布事件到事件总线
    ↓
SSEAdapter 接收事件
    ↓
_simplify_event_format() 转换格式  ← ✨ 新增
    ↓
(如果是 final_answer) 拆分为 chunks  ← ✨ 新增
    ↓
格式化为 SSE（"data: {...}\n\n"）
    ↓
流式输出到前端
    ↓
检测到 session.end/agent.end  ← ✨ 新增
    ↓
自动停止 SSE 流  ← ✨ 新增
```

---

## 🎯 测试验证

### 测试用例 1: 简单问候

**输入**: "你好"

**预期输出**（SSE 事件序列）：
```
data: {"type": "agent_start", "agent_name": "master_agent_v2", "task": "你好"}

data: {"type": "thought_structured", "thought": "用户只是简单的问候...", "actions": []}

data: {"type": "chunk", "content": "你好！"}
data: {"type": "chunk", "content": "我是智"}
data: {"type": "chunk", "content": "能体编"}
...
data: {"type": "chunk", "content": "吗？"}

data: {"type": "final_answer", "content": "你好！我是智能体编排器..."}

data: {"type": "agent_end", "result": "...", "execution_time": 2.5}

data: {"type": "session_end", "summary": "任务完成..."}

// ✅ SSE 流自动停止（不再发送心跳）
```

### 测试用例 2: 复杂任务（调用子 Agent）

**输入**: "查询广西受灾人口数据"

**预期输出**：
```
data: {"type": "agent_start", ...}

data: {"type": "thought_structured", "thought": "需要调用 qa_agent", "actions": ["invoke_agent_qa_agent"]}

data: {"type": "subtask_start", "agent_name": "qa_agent", "description": "..."}

data: {"type": "tool_start", "tool_name": "query_knowledge_graph_with_nl", ...}
data: {"type": "tool_end", "tool_name": "query_knowledge_graph_with_nl", ...}

data: {"type": "subtask_end", "agent_name": "qa_agent", "success": true}

data: {"type": "chunk", "content": "根据"}
data: {"type": "chunk", "content": "查询结"}
...

data: {"type": "final_answer", "content": "根据查询结果..."}

data: {"type": "agent_end", ...}
data: {"type": "session_end", ...}

// ✅ SSE 流自动停止
```

---

## 🔧 配置选项

### SSEAdapter 参数

```python
adapter = SSEAdapter(
    event_bus=event_bus,
    session_id=session_id,
    buffer_size=100,                        # 事件缓冲区大小
    heartbeat_interval=15.0,                # 心跳间隔（秒）
    enable_final_answer_streaming=True,     # ✨ 启用流式打字机效果
    chunk_size=5                            # ✨ 每个 chunk 的字符数
)
```

**推荐配置**：
- **快速响应**：`chunk_size=3` - 更流畅的打字效果
- **正常速度**：`chunk_size=5` - 平衡流畅度和网络开销（默认）
- **慢速展示**：`chunk_size=10` - 减少网络请求

---

## 📝 前端兼容性

### 完全兼容

前端代码**无需任何修改**，因为：

1. **事件格式保持不变** - SSEAdapter 自动转换为前端期望的格式
2. **事件类型保持不变** - `agent_start`, `chunk`, `final_answer` 等
3. **SSE 协议保持不变** - `data: {...}\n\n` 格式

### 前端代码示例（无需修改）

```javascript
const eventSource = new EventSource('/api/agent/stream');

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
        case 'agent_start':
            console.log('Agent 开始:', data);
            break;
        case 'chunk':
            appendToAnswer(data.content);  // 打字机效果
            break;
        case 'final_answer':
            console.log('最终答案:', data.content);
            break;
        case 'session_end':
            eventSource.close();  // 主动关闭连接
            break;
    }
};
```

---

## 🎉 修复成果

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| **事件格式** | 复杂的 Event 对象，前端无法解析 | 简化为扁平结构，完全兼容 |
| **SSE 结束** | 持续发送心跳，永不关闭 | 检测结束事件，自动停止 |
| **流式输出** | 无流式打字机效果 | 自动拆分 chunks，流畅展示 |
| **前端适配** | 需要大量修改 | 无需任何修改 |

---

## 🚀 下一步

### 1. 测试流式输出效果

```bash
# 启动后端
cd backend
python app.py

# 前端测试
# 输入："你好"
# 预期：看到逐字显示的打字机效果
```

### 2. 调整 chunk_size

如果打字机效果太快/太慢，可以调整：

```python
# routes/agent.py
adapter = SSEAdapter(
    event_bus=event_bus,
    session_id=session_id,
    chunk_size=3  # 改为 3 让打字机效果更流畅
)
```

### 3. 监控 SSE 连接

确认 SSE 流在 `session_end` 后正确关闭，不再发送心跳。

---

**修复完成时间**: 2026-02-12
**修复文件**: `backend/agents/sse_adapter.py`
**影响范围**: 前端 SSE 展示、流式输出、事件格式兼容
**测试状态**: ✅ 待验证

---

## 📚 相关文档

- **事件总线核心**: `backend/agents/event_bus.py`
- **SSE 适配器**: `backend/agents/sse_adapter.py`
- **解耦完成总结**: `backend/agents/EVENT_BUS_DECOUPLING_COMPLETE.md`

# 实时流式功能测试

**日期**: 2026-01-06
**目标**: 验证 ReActAgent 的 `execute_stream()` 方法能否实时发送事件

---

## 修改内容

### 1. ReActAgent 新增 `execute_stream()` 方法

**文件**: `backend/agents/react_agent.py`
**行数**: 185-362

**核心改变**:
- 将原本在 `_emit_event()` 中使用回调的机制改为**直接 yield**
- 每个关键事件（thought_structured, tool_start, tool_end, final_answer）都实时 yield
- 保留原有的 `execute()` 方法用于向后兼容

**事件类型**:
```python
yield {"type": "thought_structured", "thought": "...", "round": 1, ...}
yield {"type": "tool_start", "tool_name": "...", "arguments": {...}, ...}
yield {"type": "tool_end", "tool_name": "...", "result": {...}, "elapsed_time": 0.82, ...}
yield {"type": "final_answer", "content": "...", "metadata": {...}}
yield {"type": "error", "content": "..."}
```

### 2. MasterAgent 更新流式委托方法

**文件**: `backend/agents/master_agent.py`

#### 修改 1: `_stream_delegate_to_single_agent()` (271-384行)

**改变**:
- 检查 Agent 是否有 `execute_stream` 方法
- 如果有，直接使用流式执行并实时转发事件
- 如果没有，降级到旧的回调队列机制（保持兼容性）

**代码逻辑**:
```python
if agent and hasattr(agent, 'execute_stream'):
    # 🎉 新的流式路径
    for event in agent.execute_stream(task, context):
        if event['type'] == 'final_answer':
            yield {"type": "chunk", "content": event['content']}
        else:
            yield event  # 实时转发
else:
    # 🔧 降级路径（旧的回调队列）
    event_queue = []
    def event_callback(...): event_queue.append(...)
    # ... 执行后批量转发
```

#### 修改 2: `_stream_coordinate_multiple_agents()` (450-531行)

**改变**:
- 多智能体协调时，每个子任务也使用流式执行
- 实时转发子任务的事件流
- 捕获 `final_answer` 构建 response 对象

---

## 工作原理

### 之前的问题

```
MasterAgent (Generator)
  └─ orchestrator.execute() [阻塞!]
       └─ ReActAgent.execute() [阻塞!]
            └─ 内部循环多轮
                 └─ _emit_event() → event_callback() → event_queue.append()
                                                              ⬇️
                                                        累积所有事件
            ⬆️ 返回后才开始 yield
  ⬆️ 批量转发所有事件
```

**结果**: 所有事件在同一时间戳发送（20:54:12.686）

### 修复后的流程

```
MasterAgent (Generator)
  └─ agent.execute_stream() [Generator!]
       └─ ReActAgent.execute_stream() [Generator!]
            └─ 第1轮推理
                 └─ yield {"type": "thought_structured", ...}  ← 立即发送
            └─ 工具调用 1
                 └─ yield {"type": "tool_start", ...}  ← 立即发送
                 └─ execute_tool()  [耗时 2.5s]
                 └─ yield {"type": "tool_end", ...}    ← 立即发送
            └─ 第2轮推理
                 └─ yield {"type": "thought_structured", ...}  ← 立即发送
            └─ final_answer
                 └─ yield {"type": "final_answer", ...}  ← 立即发送
```

**结果**: 事件在不同时间戳实时发送

---

## 预期 SSE 时间轴

修复后，时间戳应该分散：

```
20:54:00.100  → thought_structured (第1轮)
20:54:00.150  → tool_start (query_kg)
20:54:02.650  → tool_end (query_kg, elapsed: 2.5s)
20:54:02.700  → thought_structured (第2轮)
20:54:02.750  → final_answer
```

而不是所有事件都在 `20:54:12.686` 挤在一起。

---

## 兼容性保证

1. **旧 Agent 仍能工作**: 如果某个 Agent 没有 `execute_stream()`，自动降级到回调队列模式
2. **非流式接口保留**: `execute()` 方法仍然存在，返回 `AgentResponse` 对象
3. **事件回调仍然支持**: `event_callback` 机制保留，只是优先使用流式

---

## 测试方法

1. 启动后端：`python backend/app.py`
2. 前端提问：**"查询桂林2020年的洪涝灾害情况"**
3. 打开浏览器开发者工具 → Network → 找到 SSE 连接
4. 观察消息时间戳是否分散

---

## 成功标志

✅ 思考过程、工具调用、最终答案分别在不同时间出现
✅ 工具执行期间能看到 "tool_start"，结束后才看到 "tool_end"
✅ 前端 UI 逐步更新（不是一下子全部显示）
✅ 后端日志显示 "[MasterAgent] 使用流式执行 qa_agent"

---

## 技术细节

### 为什么不能在回调中 yield？

Python Generator 的限制：`yield` 只能在 Generator 函数的直接作用域中使用，不能在嵌套的回调函数中使用。

```python
def generator():
    def callback():
        yield 1  # ❌ SyntaxError: 'yield' outside function
    callback()

def generator():
    yield 1  # ✅ 可以
```

### 为什么改用 Generator 就能实时？

因为 Generator 是**惰性执行**的：

```python
# 流式执行
for event in agent.execute_stream(task):
    yield event  # 收到一个，立即转发一个
```

而不是：

```python
# 批量执行
events = []
agent.execute(task)  # 等待完成
for event in events:
    yield event  # 全部完成后才转发
```

---

**状态**: ⏳ 待测试
**预期结果**: 实时流式更新，无延迟批量加载

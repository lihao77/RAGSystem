# 工具调用可视化修复说明

**问题**: 复杂任务（多智能体协作）不显示工具调用详情
**日期**: 2026-01-06
**状态**: ✅ 已修复

---

## 问题描述

用户提问："查询桂林2020年的洪涝灾害情况，以及如果再次发生相同规模的洪涝灾害，应该如何应急"

**预期行为**: 前端应显示工具调用卡片和结构化思考过程
**实际行为**: 前端只显示最终答案，没有工具调用详情

---

## 根本原因

### 任务类型差异

系统有两种任务处理流程：

1. **简单任务** - 由单个 Agent 处理
   - 流程：`MasterAgent` → `_stream_delegate_to_single_agent()` → 单个 Agent
   - 事件转发：✅ 已实现（第 271-373 行）

2. **复杂任务** - 需要多个 Agent 协作
   - 流程：`MasterAgent` → `_stream_coordinate_multiple_agents()` → 多个 Agent
   - 事件转发：❌ **未实现**（这就是问题所在）

### 代码分析

用户的问题被 MasterAgent 分析为 **complex 任务**，分解为 2 个子任务：
1. 查询桂林2020年洪涝灾害 → `qa_agent`
2. 查询应急预案 → `emergency_plan_agent`

执行流程走的是 `_stream_coordinate_multiple_agents()` 方法（第 403 行开始），但该方法在执行子任务时（第 441 行）**没有设置事件回调**，导致：

```python
# 原代码（第 441-445 行）
response = self.orchestrator.execute(
    task=subtask_desc,
    context=context,
    preferred_agent=agent_name
)
# ❌ 没有设置 event_callback，工具调用事件丢失
```

---

## 修复方案

在 `_stream_coordinate_multiple_agents()` 方法中添加事件回调机制，与 `_stream_delegate_to_single_agent()` 保持一致。

### 修改位置

**文件**: `backend/agents/master_agent.py`
**方法**: `_stream_coordinate_multiple_agents()`
**行数**: 439-496

### 修复代码

```python
# 执行子任务，设置事件回调以转发工具调用事件
try:
    # 创建事件队列
    event_queue = []

    def event_callback(event_type: str, data: Dict[str, Any]):
        if event_type == 'tool_start':
            event_queue.append({
                "type": "tool_start",
                "tool_name": data['tool_name'],
                "arguments": data['arguments'],
                "index": data['index'],
                "total": data['total']
            })
        elif event_type == 'tool_end':
            event_queue.append({
                "type": "tool_end",
                "tool_name": data['tool_name'],
                "result": data['result'],
                "elapsed_time": data['elapsed_time'],
                "index": data['index'],
                "total": data['total']
            })
        elif event_type == 'thought_structured':
            event_queue.append({
                "type": "thought_structured",
                "thought": data['thought'],
                "round": data['round'],
                "has_actions": data['has_actions'],
                "has_answer": data['has_answer']
            })

    # 获取 agent 并设置回调
    agent = self.orchestrator.agents.get(agent_name)
    if agent and hasattr(agent, 'event_callback'):
        old_callback = agent.event_callback
        agent.event_callback = event_callback

        # 执行任务
        response = self.orchestrator.execute(
            task=subtask_desc,
            context=context,
            preferred_agent=agent_name
        )

        # 恢复回调
        agent.event_callback = old_callback

        # 转发队列中的事件
        for event in event_queue:
            yield event
    else:
        # Agent 不支持事件回调，直接执行
        response = self.orchestrator.execute(
            task=subtask_desc,
            context=context,
            preferred_agent=agent_name
        )
```

---

## 验证方法

### 测试问题

使用相同的问题再次测试：
```
查询桂林2020年的洪涝灾害情况，以及如果再次发生相同规模的洪涝灾害，应该如何应急
```

### 预期 SSE 流

修复后，SSE 流应包含：

```
data: {"type": "agent_start", "agent": "qa_agent", ...}
data: {"type": "thought_structured", "thought": "...", "round": 1, ...}
data: {"type": "tool_start", "tool_name": "query_knowledge_graph_with_nl", ...}
data: {"type": "tool_end", "tool_name": "query_knowledge_graph_with_nl", "result": ..., "elapsed_time": 0.82}
data: {"type": "agent_end", "agent": "qa_agent"}
data: {"type": "agent_start", "agent": "emergency_plan_agent", ...}
data: {"type": "thought_structured", ...}
data: {"type": "tool_start", ...}
data: {"type": "tool_end", ...}
data: {"type": "agent_end", "agent": "emergency_plan_agent"}
data: {"type": "chunk", "content": "最终答案..."}
```

### 预期前端显示

1. **工具调用卡片**
   - 🔧 工具调用记录
   - 统计：N 个工具，总耗时 X.XXs，成功率 X/X
   - 每个工具的参数、结果、执行时间

2. **结构化思考过程**
   - ▼ 思考过程 (N 步)
   - 编号徽章 + 类型图标 + 思考内容

3. **智能体流转指示**
   - 🤖 正在调用 qa_agent 处理任务...
   - 🤖 正在调用 emergency_plan_agent 处理任务...

---

## 技术细节

### 事件流转路径

```
ReActAgent.execute()
    └─→ _emit_event('tool_start', ...)
         └─→ event_callback (MasterAgent 设置)
              └─→ event_queue.append(...)
                   └─→ yield event (转发到 SSE)
                        └─→ 前端接收并更新 UI
```

### 为什么使用事件队列

由于 Python 的 Generator 不能在回调函数中 `yield`，我们使用队列模式：
1. 回调函数将事件添加到 `event_queue`
2. 执行完成后，遍历队列并 `yield` 所有事件
3. 前端按顺序接收并处理事件

### 兼容性

- ✅ 支持没有 `event_callback` 的旧 Agent
- ✅ 不影响不使用工具的 Agent（如 MasterAgent 自己的对话）
- ✅ 保持向后兼容（旧的 `thinking` 字段仍然保留）

---

## 相关文件

- `backend/agents/master_agent.py` - 修复的主文件
- `backend/agents/react_agent.py` - 事件发送源
- `frontend-client/src/App.vue` - 事件接收和展示

---

## 总结

这是一个**事件转发缺失**的问题：
- ✅ 单智能体任务 - 事件正常转发
- ❌ 多智能体任务 - 事件丢失（已修复）

修复后，**所有类型的任务**（简单/复杂）都能正确显示工具调用详情和思考过程。

---

**修复完成时间**: 2026-01-06
**验证状态**: ⏳ 待测试

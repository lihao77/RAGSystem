# SSE 事件格式规范 - 前端展示指南（完整 Event 对象格式）

## 📋 概述

本文档定义了事件总线通过 SSE 发送给前端的**完整Event对象格式**，保留了所有事件元数据和追踪信息，让前端能够：
- 区分不同 agent 的事件
- 识别主 agent 和子 agent 的调用关系
- 正确显示工具调用的归属
- 展示完整的执行流程
- 追踪事件的完整生命周期

---

## 🏗️ 完整 Event 对象结构

### 所有事件的通用结构

```json
{
  // ✨ 事件类型（使用 EventType 枚举值）
  "type": "agent.subtask_start",

  // ✨ 事件元数据
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1770829031.003,
  "priority": "normal",

  // ✨ 会话和追踪信息
  "session_id": "abc123...",
  "trace_id": "xyz789...",
  "span_id": "span123...",

  // ✨ Agent 信息
  "agent_name": "master_agent_v2",

  // ✨ 事件特定数据（在 data 字段中）
  "data": {
    // 事件特定的数据字段
    ...
  },

  // ✨ 用户交互
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**关键改变**：
- 事件类型使用完整的 EventType 枚举值（如 `agent.subtask_start`）
- 所有事件特定数据在 `data` 字段中
- 保留完整的元数据（event_id、priority、trace_id 等）

---

## 📦 事件类型详解

### 1. Agent 开始 (`agent.start`)

**何时触发**：Agent 开始执行任务

**示例**：
```json
{
  "type": "agent.start",
  "event_id": "550e8400-e29b-41d4-a716-446655440001",
  "timestamp": 1770829031.003,
  "priority": "normal",
  "session_id": "abc123",
  "trace_id": null,
  "span_id": null,
  "agent_name": "master_agent_v2",
  "data": {
    "agent_name": "master_agent_v2",
    "task": "查询广西受灾人口数据",
    "metadata": {
      "agent_name": "master_agent_v2",
      "display_name": "MasterAgent V2",
      "max_rounds": 15
    }
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
[MasterAgent V2] 开始执行任务：查询广西受灾人口数据
```

---

### 2. 思考过程 (`agent.thought_structured`)

**何时触发**：Agent 进行推理分析

**示例**：
```json
{
  "type": "agent.thought_structured",
  "event_id": "550e8400-e29b-41d4-a716-446655440002",
  "timestamp": 1770829033.529,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "thought": "需要调用 qa_agent 查询知识图谱",
    "actions": ["invoke_agent_qa_agent"],
    "reasoning": "第 1 轮推理"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
💭 [MasterAgent V2] 思考：
需要调用 qa_agent 查询知识图谱

计划行动：
- 调用 invoke_agent_qa_agent
```

---

### 3. 子任务开始 (`agent.subtask_start`)

**何时触发**：主 agent 调用子 agent

**示例**：
```json
{
  "type": "subtask.start",
  "event_id": "550e8400-e29b-41d4-a716-446655440003",
  "timestamp": 1770829034.123,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "subtask_agent": "qa_agent",
    "subtask_description": "查询受灾人口数据",
    "task_id": "v2_agent_1_1",
    "order": 1,
    "round": 1
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
┌─ [MasterAgent V2] 调用子智能体
│  → [qa_agent] 查询受灾人口数据
│  task_id: v2_agent_1_1, order: 1, round: 1
```

**前端逻辑**：
```javascript
if (event.type === 'subtask.start') {
  const data = event.data;
  console.log(`  └─ ${event.agent_name} 调用 ${data.subtask_agent}`);
  console.log(`     任务ID: ${data.task_id}, 顺序: ${data.order}, 轮次: ${data.round}`);
  console.log(`     任务：${data.subtask_description}`);
}
```

---

### 4. 工具调用开始 (`agent.tool_start`)

**何时触发**：Agent 开始调用工具

**示例**：
```json
{
  "type": "tool.start",
  "event_id": "550e8400-e29b-41d4-a716-446655440004",
  "timestamp": 1770829035.456,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "qa_agent",
  "data": {
    "tool_name": "query_knowledge_graph_with_nl",
    "arguments": {
      "query": "广西各市受灾人口数据"
    },
    "task_id": "v2_agent_1_1"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
  🔧 [qa_agent] 调用工具：query_knowledge_graph_with_nl
  task_id: v2_agent_1_1
  参数：{"query": "广西各市受灾人口数据"}
```

**关键点**：通过 `agent_name` 字段，前端能知道是 `qa_agent` 调用的工具；通过 `data.task_id` 能关联到父任务。

---

### 5. 工具调用结束 (`agent.tool_end`)

**何时触发**：工具执行完成

**示例**：
```json
{
  "type": "tool.end",
  "event_id": "550e8400-e29b-41d4-a716-446655440005",
  "timestamp": 1770829036.789,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "qa_agent",
  "data": {
    "tool_name": "query_knowledge_graph_with_nl",
    "result": {
      "success": true,
      "data": {
        "results": "查询到 10 条数据..."
      }
    },
    "execution_time": 1.333,
    "task_id": "v2_agent_1_1"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
  ✅ [qa_agent] 工具执行完成 (1.33秒)
  task_id: v2_agent_1_1
  结果：查询到 10 条数据...
```

---

### 6. 子任务结束 (`agent.subtask_end`)

**何时触发**：子 agent 执行完成

**示例**：
```json
{
  "type": "subtask.end",
  "event_id": "550e8400-e29b-41d4-a716-446655440006",
  "timestamp": 1770829037.123,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "subtask_agent": "qa_agent",
    "subtask_result": "成功查询到受灾人口数据：南宁市 12.5万人...",
    "success": true,
    "task_id": "v2_agent_1_1",
    "order": 1
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
└─ [qa_agent] 执行完成 ✓
   task_id: v2_agent_1_1, order: 1
   结果：成功查询到受灾人口数据
```

---

### 7. 流式输出 (`output.chunk`)

**何时触发**：流式输出答案的每一小段

**示例**：
```json
{
  "type": "output.chunk",
  "event_id": "550e8400-e29b-41d4-a716-446655440007",
  "timestamp": 1770829038.001,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "content": "根据查"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```javascript
// 逐字追加到答案框
answerText += event.data.content;  // "根据查"
```

---

### 8. 最终答案 (`output.final_answer`)

**何时触发**：Agent 返回最终答案

**示例**：
```json
{
  "type": "output.final_answer",
  "event_id": "550e8400-e29b-41d4-a716-446655440008",
  "timestamp": 1770829039.500,
  "priority": "high",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "content": "根据查询，广西各市受灾人口数据如下：南宁市 12.5万人..."
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
📝 [MasterAgent V2] 最终答案：
根据查询，广西各市受灾人口数据如下...
```

---

### 9. Agent 结束 (`agent.end`)

**何时触发**：Agent 执行完成

**示例**：
```json
{
  "type": "agent.end",
  "event_id": "550e8400-e29b-41d4-a716-446655440009",
  "timestamp": 1770829040.000,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "agent_name": "master_agent_v2",
    "result": "根据查询，广西各市受灾人口数据...",
    "execution_time": 8.997
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
✓ [MasterAgent V2] 执行完成 (8.99秒)
```

---

### 10. 会话结束 (`agent.session_end`)

**何时触发**：整个会话结束（SSE 流将在此后停止）

**示例**：
```json
{
  "type": "agent.session_end",
  "event_id": "550e8400-e29b-41d4-a716-446655440010",
  "timestamp": 1770829040.001,
  "priority": "normal",
  "session_id": "abc123",
  "agent_name": "master_agent_v2",
  "data": {
    "session_id": "abc123",
    "summary": "任务完成，共 2 轮推理，1 次Agent调用"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

**前端展示**：
```
🎉 会话结束
任务完成，共 2 轮推理，1 次Agent调用
```

**前端逻辑**：
```javascript
if (event.type === 'agent.session_end') {
  eventSource.close();  // 主动关闭 SSE 连接
}
```

---

## 🎯 前端展示逻辑示例

### 完整对话流程的前端展示

```javascript
const decoder = new TextDecoder();
const response = await fetch('/api/agent/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ task, session_id })
});

const reader = response.body.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\n\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.substring(6));

      // ✨ 提取事件数据（完整Event对象格式）
      const eventData = event.data || {};
      const eventType = event.type;
      const agentLabel = `[${event.agent_name || 'System'}]`;

      switch (eventType) {
        case 'agent.start':
          console.log(`${agentLabel} 开始执行：${eventData.task}`);
          break;

        case 'agent.thought_structured':
          console.log(`💭 ${agentLabel} 思考：${eventData.thought}`);
          if (eventData.actions && eventData.actions.length > 0) {
            console.log(`   计划行动：${eventData.actions.join(', ')}`);
          }
          break;

        case 'subtask.start':
          console.log(`  ┌─ ${agentLabel} 调用子智能体`);
          console.log(`  │  → [${eventData.subtask_agent}] ${eventData.subtask_description}`);
          console.log(`  │  task_id: ${eventData.task_id}, order: ${eventData.order}, round: ${eventData.round}`);
          break;

        case 'tool.start':
          console.log(`    🔧 ${agentLabel} 调用工具：${eventData.tool_name}`);
          console.log(`       task_id: ${eventData.task_id}`);
          break;

        case 'tool.end':
          console.log(`    ✅ ${agentLabel} 工具完成 (${eventData.execution_time}秒)`);
          break;

        case 'subtask.end':
          console.log(`  └─ [${eventData.subtask_agent}] 执行完成 ${eventData.success ? '✓' : '✗'}`);
          break;

        case 'output.chunk':
          // 流式追加答案
          appendAnswer(eventData.content);
          break;

        case 'output.final_answer':
          console.log(`📝 ${agentLabel} 最终答案：${eventData.content}`);
          break;

        case 'agent.end':
          console.log(`✓ ${agentLabel} 执行完成 (${eventData.execution_time}秒)`);
          break;

        case 'agent.session_end':
          console.log(`🎉 会话结束：${eventData.summary}`);
          reader.cancel();
          break;

        case 'agent.error':
          console.error(`❌ ${agentLabel} 错误：${eventData.error}`);
          break;
      }
    }
  }
}
```

---

## 📊 事件字段对照表

| 前端需求 | 事件字段 | 位置 | 说明 |
|---------|---------|------|------|
| 事件类型 | `type` | 顶层 | EventType 枚举值（如 `agent.subtask_start`） |
| 事件ID | `event_id` | 顶层 | UUID，用于追踪事件 |
| 时间戳 | `timestamp` | 顶层 | Unix时间戳 |
| 优先级 | `priority` | 顶层 | normal, high, low |
| 会话ID | `session_id` | 顶层 | 会话隔离 |
| 追踪ID | `trace_id` | 顶层 | 分布式追踪 |
| Span ID | `span_id` | 顶层 | 分布式追踪 |
| Agent名称 | `agent_name` | 顶层 | 发布事件的 agent |
| 事件数据 | `data` | 顶层 | 事件特定数据（对象） |
| 任务ID | `data.task_id` | data | 任务追踪ID（如 `v2_agent_1_1`） |
| 调用顺序 | `data.order` | data | 全局调用序号 |
| 推理轮次 | `data.round` | data | 第几轮推理 |
| 用户交互 | `requires_user_action` | 顶层 | 是否需要用户操作 |
| 超时时间 | `user_action_timeout` | 顶层 | 用户操作超时（秒） |

---

## ✅ 关键改进

### 改进前（简化格式）

```json
{
  "type": "tool_start",
  "agent_name": "qa_agent",
  "session_id": "abc123",
  "timestamp": 1770829035.456,
  "tool_name": "query_kg",
  "arguments": {...}
}
```

❌ **问题**：
- 事件数据扁平化，难以扩展
- 缺少事件ID、优先级等元数据
- 无法追踪事件的完整生命周期

### 改进后（完整Event对象格式）

```json
{
  "type": "agent.tool_start",
  "event_id": "550e8400-e29b-41d4-a716-446655440004",
  "timestamp": 1770829035.456,
  "priority": "normal",
  "session_id": "abc123",
  "trace_id": "xyz789",
  "span_id": "span123",
  "agent_name": "qa_agent",
  "data": {
    "tool_name": "query_kg",
    "arguments": {...},
    "task_id": "v2_agent_1_1"
  },
  "requires_user_action": false,
  "user_action_timeout": null
}
```

✅ **优势**：
- 完整的元数据（event_id, priority, trace_id）
- 事件数据结构清晰（在 `data` 字段中）
- 支持分布式追踪
- 支持用户交互（requires_user_action）
- 易于扩展和维护

---

**文档版本**: 2.0
**更新时间**: 2026-02-12
**适用范围**: 事件总线 SSE 流式输出（完整Event对象格式）
**关键优势**: 完整元数据、清晰结构、易于追踪、支持用户交互

---

## 📦 事件类型详解

### 1. Agent 开始 (`agent_start`)

**何时触发**：Agent 开始执行任务

**示例**：
```json
{
  "type": "agent_start",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829031.003,
  "task": "查询广西受灾人口数据",
  "metadata": {
    "agent_name": "master_agent_v2",
    "display_name": "MasterAgent V2",
    "max_rounds": 15
  }
}
```

**前端展示**：
```
[MasterAgent V2] 开始执行任务：查询广西受灾人口数据
```

---

### 2. 思考过程 (`thought_structured`)

**何时触发**：Agent 进行推理分析

**示例**：
```json
{
  "type": "thought_structured",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829033.529,
  "thought": "需要调用 qa_agent 查询知识图谱",
  "actions": ["invoke_agent_qa_agent"],
  "reasoning": "第 1 轮推理"
}
```

**前端展示**：
```
💭 [MasterAgent V2] 思考：
需要调用 qa_agent 查询知识图谱

计划行动：
- 调用 invoke_agent_qa_agent
```

---

### 3. 子任务开始 (`subtask_start`)

**何时触发**：主 agent 调用子 agent

**示例**：
```json
{
  "type": "subtask_start",
  "agent_name": "master_agent_v2",        // ✨ 调用者（主agent）
  "session_id": "abc123",
  "timestamp": 1770829034.123,
  "subtask_agent": "qa_agent",            // ✨ 被调用的子agent
  "subtask_description": "查询受灾人口数据",
  "is_subtask": true,                     // ✨ 标记为子任务
  "parent_agent": "master_agent_v2"       // ✨ 明确父agent
}
```

**前端展示**：
```
┌─ [MasterAgent V2] 调用子智能体
│  → [qa_agent] 查询受灾人口数据
```

**前端逻辑**：
```javascript
if (data.is_subtask) {
  // 这是子任务，显示缩进或层级结构
  console.log(`  └─ ${data.parent_agent} 调用 ${data.subtask_agent}`);
  console.log(`     任务：${data.subtask_description}`);
}
```

---

### 4. 工具调用开始 (`tool_start`)

**何时触发**：Agent 开始调用工具

**示例**：
```json
{
  "type": "tool_start",
  "agent_name": "qa_agent",                  // ✨ 调用工具的 agent
  "session_id": "abc123",
  "timestamp": 1770829035.456,
  "tool_name": "query_knowledge_graph_with_nl",
  "arguments": {
    "query": "广西各市受灾人口数据"
  }
}
```

**前端展示**：
```
  🔧 [qa_agent] 调用工具：query_knowledge_graph_with_nl
  参数：{"query": "广西各市受灾人口数据"}
```

**关键点**：通过 `agent_name` 字段，前端能知道是 `qa_agent` 调用的工具，而不是 `master_agent_v2`

---

### 5. 工具调用结束 (`tool_end`)

**何时触发**：工具执行完成

**示例**：
```json
{
  "type": "tool_end",
  "agent_name": "qa_agent",
  "session_id": "abc123",
  "timestamp": 1770829036.789,
  "tool_name": "query_knowledge_graph_with_nl",
  "result": {
    "success": true,
    "data": {
      "results": "查询到 10 条数据..."
    }
  },
  "elapsed_time": 1.333
}
```

**前端展示**：
```
  ✅ [qa_agent] 工具执行完成 (1.33秒)
  结果：查询到 10 条数据...
```

---

### 6. 子任务结束 (`subtask_end`)

**何时触发**：子 agent 执行完成

**示例**：
```json
{
  "type": "subtask_end",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829037.123,
  "subtask_agent": "qa_agent",
  "subtask_result": "成功查询到受灾人口数据：南宁市 12.5万人...",
  "success": true,
  "is_subtask": true,
  "parent_agent": "master_agent_v2"
}
```

**前端展示**：
```
└─ [qa_agent] 执行完成 ✓
   结果：成功查询到受灾人口数据
```

---

### 7. 流式输出 (`chunk`)

**何时触发**：流式输出答案的每一小段

**示例**：
```json
{
  "type": "chunk",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829038.001,
  "content": "根据查"
}
```

**前端展示**：
```javascript
// 逐字追加到答案框
answerText += data.content;  // "根据查"
```

---

### 8. 最终答案 (`final_answer`)

**何时触发**：Agent 返回最终答案

**示例**：
```json
{
  "type": "final_answer",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829039.500,
  "content": "根据查询，广西各市受灾人口数据如下：南宁市 12.5万人..."
}
```

**前端展示**：
```
📝 [MasterAgent V2] 最终答案：
根据查询，广西各市受灾人口数据如下...
```

---

### 9. Agent 结束 (`agent_end`)

**何时触发**：Agent 执行完成

**示例**：
```json
{
  "type": "agent_end",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829040.000,
  "result": "根据查询，广西各市受灾人口数据...",
  "execution_time": 8.997
}
```

**前端展示**：
```
✓ [MasterAgent V2] 执行完成 (8.99秒)
```

---

### 10. 会话结束 (`session_end`)

**何时触发**：整个会话结束（SSE 流将在此后停止）

**示例**：
```json
{
  "type": "session_end",
  "agent_name": "master_agent_v2",
  "session_id": "abc123",
  "timestamp": 1770829040.001,
  "summary": "任务完成，共 2 轮推理，1 次Agent调用"
}
```

**前端展示**：
```
🎉 会话结束
任务完成，共 2 轮推理，1 次Agent调用
```

**前端逻辑**：
```javascript
if (data.type === 'session_end') {
  eventSource.close();  // 主动关闭 SSE 连接
}
```

---

## 🎯 前端展示逻辑示例

### 完整对话流程的前端展示

```javascript
const eventSource = new EventSource('/api/agent/stream');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  // ✨ 根据 agent_name 区分不同 agent 的事件
  const agentLabel = `[${data.agent_name || 'System'}]`;

  switch (data.type) {
    case 'agent_start':
      console.log(`${agentLabel} 开始执行：${data.task}`);
      break;

    case 'thought_structured':
      console.log(`💭 ${agentLabel} 思考：${data.thought}`);
      if (data.actions && data.actions.length > 0) {
        console.log(`   计划行动：${data.actions.join(', ')}`);
      }
      break;

    case 'subtask_start':
      // ✨ 识别子任务，显示层级关系
      if (data.is_subtask) {
        console.log(`  ┌─ ${agentLabel} 调用子智能体`);
        console.log(`  │  → [${data.subtask_agent}] ${data.subtask_description}`);
      }
      break;

    case 'tool_start':
      // ✨ 显示是哪个 agent 调用的工具
      console.log(`    🔧 ${agentLabel} 调用工具：${data.tool_name}`);
      break;

    case 'tool_end':
      console.log(`    ✅ ${agentLabel} 工具完成 (${data.elapsed_time}秒)`);
      break;

    case 'subtask_end':
      if (data.is_subtask) {
        console.log(`  └─ [${data.subtask_agent}] 执行完成 ${data.success ? '✓' : '✗'}`);
      }
      break;

    case 'chunk':
      // 流式追加答案
      appendAnswer(data.content);
      break;

    case 'final_answer':
      console.log(`📝 ${agentLabel} 最终答案：${data.content}`);
      break;

    case 'agent_end':
      console.log(`✓ ${agentLabel} 执行完成 (${data.execution_time}秒)`);
      break;

    case 'session_end':
      console.log(`🎉 会话结束：${data.summary}`);
      eventSource.close();
      break;

    case 'error':
      console.error(`❌ ${agentLabel} 错误：${data.content}`);
      break;
  }
};
```

---

## 🔍 典型场景示例

### 场景 1: 简单问候

```
[master_agent_v2] 开始执行：你好

💭 [master_agent_v2] 思考：
用户只是简单的问候，不需要调用任何Agent，直接回复即可。

📝 [master_agent_v2] 最终答案：
你好！我是智能体编排器，可以帮你处理广西洪涝灾害相关的复杂任务...

✓ [master_agent_v2] 执行完成 (2.53秒)

🎉 会话结束
```

### 场景 2: 复杂查询（调用子 Agent）

```
[master_agent_v2] 开始执行：查询广西各市受灾人口数据

💭 [master_agent_v2] 思考：
需要调用 qa_agent 查询知识图谱
计划行动：invoke_agent_qa_agent

┌─ [master_agent_v2] 调用子智能体
│  → [qa_agent] 查询广西各市受灾人口数据

  💭 [qa_agent] 思考：使用自然语言查询工具

  🔧 [qa_agent] 调用工具：query_knowledge_graph_with_nl
  参数：{"query": "广西各市受灾人口"}

  ✅ [qa_agent] 工具完成 (1.33秒)
  结果：查询到 10 条数据

└─ [qa_agent] 执行完成 ✓

💭 [master_agent_v2] 思考：
已获取数据，整合结果生成答案

📝 [master_agent_v2] 最终答案：
根据查询，广西各市受灾人口数据如下：
- 南宁市：12.5万人
- 柳州市：8.3万人
...

✓ [master_agent_v2] 执行完成 (8.99秒)

🎉 会话结束
```

---

## 🎨 前端 UI 建议

### 层级显示

使用缩进或树形结构展示主 agent 和子 agent 的关系：

```
MasterAgent V2
├─ 思考：需要调用 qa_agent
├─ 调用子智能体：qa_agent
│   ├─ 思考：使用自然语言查询
│   ├─ 调用工具：query_knowledge_graph_with_nl
│   └─ 工具完成 ✓
├─ 子任务完成 ✓
└─ 最终答案：...
```

### 颜色编码

- **主 Agent** (master_agent_v2): 蓝色
- **子 Agent** (qa_agent, workflow_agent): 绿色
- **工具调用**: 橙色
- **错误**: 红色

### 图标标识

- 💭 思考
- 🔧 工具调用
- 📊 图表生成
- 📝 最终答案
- ✓ 成功
- ✗ 失败

---

## 📊 事件字段对照表

| 前端需求 | 事件字段 | 说明 |
|---------|---------|------|
| 区分不同 agent | `agent_name` | 发布事件的 agent 名称 |
| 识别主子关系 | `is_subtask`, `parent_agent`, `subtask_agent` | 子任务特有字段 |
| 显示工具归属 | `agent_name` | tool_start/tool_end 的 agent_name 指明调用者 |
| 显示执行时间 | `timestamp`, `elapsed_time`, `execution_time` | 各类完成事件包含 |
| 追踪请求 | `trace_id`, `span_id` | 分布式追踪字段 |
| 会话隔离 | `session_id` | 所有事件包含 |

---

## ✅ 关键改进

与之前的简化格式相比，新格式**保留了关键元数据**：

### 改进前（过度简化）

```json
{
  "type": "tool_start",
  "tool_name": "query_kg",
  "arguments": {...}
}
```

❌ **问题**：前端不知道是谁调用的工具

### 改进后（保留上下文）

```json
{
  "type": "tool_start",
  "agent_name": "qa_agent",        // ✅ 明确是 qa_agent 调用
  "session_id": "abc123",          // ✅ 会话隔离
  "timestamp": 1770829035.456,     // ✅ 时间戳
  "tool_name": "query_kg",
  "arguments": {...}
}
```

✅ **优势**：前端能清晰展示 `[qa_agent] 调用工具：query_kg`

---

## 🚀 测试验证

### 测试用例

```bash
# 测试简单问候
curl -X POST http://localhost:5000/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{"task": "你好", "session_id": "test123"}'

# 预期：看到 agent_name 字段正确显示 "master_agent_v2"
```

---

**文档版本**: 1.0
**创建时间**: 2026-02-12
**适用范围**: 事件总线 SSE 流式输出

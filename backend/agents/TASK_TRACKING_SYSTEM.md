# 精细化任务追踪 - 事件关联系统

## 🎯 问题与解决方案

### 问题
一轮对话中可能有**多次 agent 调用和多个工具调用**，前端无法区分它们的归属关系：

```
MasterAgent V2 → 第1次调用 qa_agent
                   ├─ tool_start: query_kg      ❌ 属于第几次调用？
                   └─ tool_end: query_kg
               → 第2次调用 qa_agent
                   ├─ tool_start: query_kg      ❌ 和第1次如何区分？
                   └─ tool_end: query_kg
               → 调用 chart_agent
                   ├─ tool_start: generate_chart
                   └─ tool_end: generate_chart
```

### 解决方案
为每次子任务调用生成**唯一的 task_id**，所有相关事件都携带该 task_id：

```
✅ 前端可以根据 task_id 将事件归类：
- task_id="v2_agent_1_1" 的所有事件 → 第1次 qa_agent 调用
- task_id="v2_agent_1_2" 的所有事件 → 第2次 qa_agent 调用
- task_id="v2_agent_2_1" 的所有事件 → 第2轮第1次调用
```

---

## 📦 新增的追踪字段

### 所有事件的基础字段（不变）

```json
{
  "type": "event_type",
  "agent_name": "master_agent_v2",  // 发布事件的 agent
  "session_id": "abc123",            // 会话ID
  "timestamp": 1770829031.003,       // 时间戳
  ...
}
```

### 子任务事件新增字段

#### `subtask_start` 事件

```json
{
  "type": "subtask_start",
  "agent_name": "master_agent_v2",        // 调用者（主agent）
  "subtask_agent": "qa_agent",            // 被调用的子agent
  "subtask_description": "查询受灾数据",

  // ✨ 新增：任务追踪字段
  "task_id": "v2_agent_1_1",              // 任务唯一ID
  "order": 1,                             // 全局调用顺序（递增）
  "round": 1,                             // 第几轮推理

  "session_id": "abc123",
  "timestamp": 1770829034.123
}
```

**字段说明**：
- `task_id`: 格式为 `v2_agent_{round}_{idx}`，全局唯一
- `order`: 全局递增的调用序号（1, 2, 3...），用于排序
- `round`: 第几轮推理（Master Agent 可能多轮推理）

#### `subtask_end` 事件

```json
{
  "type": "subtask_end",
  "agent_name": "master_agent_v2",
  "subtask_agent": "qa_agent",
  "subtask_result": "成功查询到数据",
  "success": true,

  // ✨ 新增：任务追踪字段
  "task_id": "v2_agent_1_1",              // 与 subtask_start 对应
  "order": 1,                             // 与 subtask_start 对应

  "session_id": "abc123",
  "timestamp": 1770829037.123
}
```

### 工具调用事件新增字段

#### `tool_start` 事件

```json
{
  "type": "tool_start",
  "agent_name": "qa_agent",               // 调用工具的 agent
  "tool_name": "query_knowledge_graph",
  "arguments": {"query": "..."},

  // ✨ 新增：关联到父任务
  "task_id": "v2_agent_1_1",              // 关联到哪个子任务

  "session_id": "abc123",
  "timestamp": 1770829035.456
}
```

**关键点**：`task_id` 与父任务的 `subtask_start` 事件的 `task_id` 相同，前端可以据此归类。

#### `tool_end` 事件

```json
{
  "type": "tool_end",
  "agent_name": "qa_agent",
  "tool_name": "query_knowledge_graph",
  "result": {...},
  "execution_time": 1.333,

  // ✨ 新增：关联到父任务
  "task_id": "v2_agent_1_1",

  "session_id": "abc123",
  "timestamp": 1770829036.789
}
```

---

## 🏗️ 事件层级关系

### 完整的事件层级结构

```
session_start (session_id="abc123")
  │
  ├─ agent_start (agent_name="master_agent_v2")
  │
  ├─ thought_structured (round=1)
  │
  ├─ subtask_start (task_id="v2_agent_1_1", order=1, round=1)
  │   ├─ agent_start (agent_name="qa_agent")
  │   ├─ thought_structured (agent_name="qa_agent")
  │   ├─ tool_start (task_id="v2_agent_1_1", agent_name="qa_agent")
  │   ├─ tool_end (task_id="v2_agent_1_1", agent_name="qa_agent")
  │   └─ agent_end (agent_name="qa_agent")
  ├─ subtask_end (task_id="v2_agent_1_1", order=1)
  │
  ├─ subtask_start (task_id="v2_agent_1_2", order=2, round=1)
  │   ├─ agent_start (agent_name="qa_agent")
  │   ├─ tool_start (task_id="v2_agent_1_2", agent_name="qa_agent")
  │   ├─ tool_end (task_id="v2_agent_1_2", agent_name="qa_agent")
  │   └─ agent_end (agent_name="qa_agent")
  ├─ subtask_end (task_id="v2_agent_1_2", order=2)
  │
  ├─ thought_structured (round=2)
  │
  ├─ final_answer
  ├─ agent_end (agent_name="master_agent_v2")
  └─ session_end
```

---

## 🎨 前端展示逻辑

### 按 task_id 归类事件

```javascript
// 维护一个任务映射
const tasks = {};  // task_id -> 事件列表

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'subtask_start':
      // 创建新任务
      tasks[data.task_id] = {
        taskId: data.task_id,
        order: data.order,
        round: data.round,
        parentAgent: data.agent_name,
        subtaskAgent: data.subtask_agent,
        description: data.subtask_description,
        events: [data],  // 初始事件
        status: 'running'
      };
      renderSubtask(tasks[data.task_id]);
      break;

    case 'tool_start':
    case 'tool_end':
      // ✅ 根据 task_id 归类到对应的子任务
      if (data.task_id && tasks[data.task_id]) {
        tasks[data.task_id].events.push(data);
        updateSubtask(tasks[data.task_id]);
      }
      break;

    case 'subtask_end':
      // 标记任务完成
      if (data.task_id && tasks[data.task_id]) {
        tasks[data.task_id].status = data.success ? 'completed' : 'failed';
        tasks[data.task_id].events.push(data);
        updateSubtask(tasks[data.task_id]);
      }
      break;
  }
};
```

### 按顺序渲染

```javascript
// 按 order 排序渲染
const sortedTasks = Object.values(tasks).sort((a, b) => a.order - b.order);

sortedTasks.forEach(task => {
  console.log(`任务 #${task.order} [${task.taskId}]`);
  console.log(`  ${task.parentAgent} 调用 ${task.subtaskAgent}`);
  console.log(`  描述：${task.description}`);

  // 渲染该任务的所有工具调用
  task.events.forEach(evt => {
    if (evt.type === 'tool_start') {
      console.log(`    🔧 调用工具：${evt.tool_name}`);
    } else if (evt.type === 'tool_end') {
      console.log(`    ✅ 工具完成：${evt.tool_name} (${evt.execution_time}秒)`);
    }
  });

  console.log(`  状态：${task.status}`);
});
```

---

## 📊 典型场景示例

### 场景：复杂查询（多次调用同一 agent）

**对话**："先查询受灾人口，再查询经济损失，最后生成对比图表"

**事件流**：

```json
// 第1轮推理
{"type": "agent_start", "agent_name": "master_agent_v2"}
{"type": "thought_structured", "thought": "需要先查询受灾人口", "round": 1}

// 第1次调用 qa_agent (查询受灾人口)
{"type": "subtask_start", "task_id": "v2_agent_1_1", "order": 1, "round": 1,
 "subtask_agent": "qa_agent", "subtask_description": "查询受灾人口"}
  {"type": "tool_start", "task_id": "v2_agent_1_1", "agent_name": "qa_agent",
   "tool_name": "query_kg"}
  {"type": "tool_end", "task_id": "v2_agent_1_1", "agent_name": "qa_agent"}
{"type": "subtask_end", "task_id": "v2_agent_1_1", "order": 1, "success": true}

// 第2轮推理
{"type": "thought_structured", "thought": "现在查询经济损失", "round": 2}

// 第2次调用 qa_agent (查询经济损失)
{"type": "subtask_start", "task_id": "v2_agent_2_1", "order": 2, "round": 2,
 "subtask_agent": "qa_agent", "subtask_description": "查询经济损失"}
  {"type": "tool_start", "task_id": "v2_agent_2_1", "agent_name": "qa_agent",
   "tool_name": "query_kg"}
  {"type": "tool_end", "task_id": "v2_agent_2_1", "agent_name": "qa_agent"}
{"type": "subtask_end", "task_id": "v2_agent_2_1", "order": 2, "success": true}

// 第3轮推理
{"type": "thought_structured", "thought": "生成对比图表", "round": 3}

// 第3次调用 (生成图表)
{"type": "subtask_start", "task_id": "v2_agent_3_1", "order": 3, "round": 3,
 "subtask_agent": "qa_agent", "subtask_description": "生成对比图表"}
  {"type": "tool_start", "task_id": "v2_agent_3_1", "agent_name": "qa_agent",
   "tool_name": "generate_chart"}
  {"type": "tool_end", "task_id": "v2_agent_3_1", "agent_name": "qa_agent"}
{"type": "subtask_end", "task_id": "v2_agent_3_1", "order": 3, "success": true}

{"type": "final_answer", "content": "已生成对比图表..."}
{"type": "agent_end"}
```

**前端展示**：

```
MasterAgent V2

第1轮推理
💭 思考：需要先查询受灾人口

任务 #1 [v2_agent_1_1]
├─ 调用：qa_agent - 查询受灾人口
│  ├─ 🔧 query_kg
│  └─ ✅ query_kg 完成 (1.2秒)
└─ 状态：✓ 完成

第2轮推理
💭 思考：现在查询经济损失

任务 #2 [v2_agent_2_1]
├─ 调用：qa_agent - 查询经济损失
│  ├─ 🔧 query_kg
│  └─ ✅ query_kg 完成 (0.9秒)
└─ 状态：✓ 完成

第3轮推理
💭 思考：生成对比图表

任务 #3 [v2_agent_3_1]
├─ 调用：qa_agent - 生成对比图表
│  ├─ 🔧 generate_chart
│  └─ ✅ generate_chart 完成 (2.1秒)
└─ 状态：✓ 完成

📝 最终答案：已生成对比图表...
```

---

## ✅ 关键改进

### 改进前（无法区分）

```json
{"type": "tool_start", "agent_name": "qa_agent", "tool_name": "query_kg"}
{"type": "tool_end", "agent_name": "qa_agent", "tool_name": "query_kg"}
{"type": "tool_start", "agent_name": "qa_agent", "tool_name": "query_kg"}
// ❌ 前端分不清这是第几次调用
```

### 改进后（精确关联）

```json
{"type": "tool_start", "task_id": "v2_agent_1_1", "agent_name": "qa_agent"}
{"type": "tool_end", "task_id": "v2_agent_1_1", "agent_name": "qa_agent"}
{"type": "tool_start", "task_id": "v2_agent_2_1", "agent_name": "qa_agent"}
// ✅ 前端通过 task_id 精确区分：第1次 vs 第2次
```

---

## 🔧 实现细节

### task_id 生成规则

```python
# MasterAgent V2 生成
task_id = f"v2_agent_{rounds}_{idx}"

# 示例：
# - v2_agent_1_1  → 第1轮第1个调用
# - v2_agent_1_2  → 第1轮第2个调用
# - v2_agent_2_1  → 第2轮第1个调用
```

### task_id 传递流程

```
MasterAgent V2 (生成 task_id)
  ↓
publisher.subtask_start(task_id="v2_agent_1_1")  // 发布事件
  ↓
child_context.metadata['parent_task_id'] = task_id  // 传递到子 Agent
  ↓
qa_agent.execute(context)  // 子 Agent 接收
  ↓
self._current_task_id = context.metadata['parent_task_id']  // 读取
  ↓
publisher.tool_start(task_id=self._current_task_id)  // 工具调用时携带
```

---

## 📚 前端数据结构建议

```typescript
interface Task {
  taskId: string;           // 任务唯一ID
  order: number;            // 全局调用顺序
  round: number;            // 第几轮推理
  parentAgent: string;      // 调用者（主agent）
  subtaskAgent: string;     // 被调用的子agent
  description: string;      // 任务描述
  status: 'running' | 'completed' | 'failed';
  events: Event[];          // 该任务的所有事件
  startTime: number;        // 开始时间
  endTime?: number;         // 结束时间
}

interface Event {
  type: string;
  agent_name: string;
  task_id?: string;         // 关联的任务ID
  timestamp: number;
  [key: string]: any;
}
```

---

**文档版本**: 1.0
**创建时间**: 2026-02-12
**适用范围**: MasterAgent V2 多次调用场景
**关键优势**: 精确追踪、清晰展示、前端易于实现

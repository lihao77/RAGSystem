# MasterAgent V2 前端兼容性分析

## 结论

✅ **MasterAgent V2 与现有前端（frontend-client）基本兼容**

但需要进行一些调整以支持 V2 的新特性。

## 兼容性分析

### 1. 现有前端支持的事件类型

前端 `ChatView.vue` 当前支持以下 SSE 事件类型：

| 事件类型 | 处理逻辑 | 兼容性 |
|---------|---------|-------|
| `task_analysis` | 显示任务分析卡片 | ✅ V2 支持 |
| `subtask_start` | 创建子任务卡片 | ✅ V2 支持 |
| `subtask_end` | 更新子任务状态 | ✅ V2 支持 |
| `thought_structured` | ReAct 推理步骤 | ✅ V2 支持 |
| `tool_start` | 工具调用开始 | ✅ V2 支持 |
| `tool_end` | 工具调用结束 | ✅ V2 支持 |
| `chunk` | 流式内容 | ✅ V2 支持 |
| `error` | 错误消息 | ✅ V2 支持 |
| `chart_generated` | 图表生成 | ✅ V2 支持 |
| `map_generated` | 地图生成 | ✅ V2 支持 |

### 2. V2 新增的事件类型

V2 引入了以下新事件类型：

| 事件类型 | 说明 | 前端支持 |
|---------|------|---------|
| `status` | 状态更新 | ❌ 需要添加 |
| `plan` | 执行计划（包含 DAG 数据） | ❌ 需要添加 |
| `subtask_skipped` | 子任务跳过 | ❌ 需要添加 |
| `execution_complete` | 执行完成摘要 | ❌ 需要添加 |

### 3. V2 的 task_analysis 事件差异

**V1 格式：**
```json
{
  "type": "task_analysis",
  "complexity": "simple",
  "subtask_count": 1,
  "reasoning": "..."
}
```

**V2 格式（需要调整）：**
```json
{
  "type": "plan",  // ⚠️ 事件名称改变
  "plan": {
    "mode": "simple",      // ⚠️ 不是 complexity
    "reasoning": "...",
    "subtasks": [...],
    "dag": {              // ✨ 新增 DAG 可视化数据
      "nodes": [...],
      "edges": [...]
    }
  },
  "mode": "simple",
  "subtask_count": 1
}
```

### 4. V2 的 subtask 事件差异

**V1 subtask_start：**
```json
{
  "type": "subtask_start",
  "order": 1,
  "agent_name": "qa_agent",
  "agent_display_name": "问答智能体",
  "description": "查询数据"
}
```

**V2 subtask_start（兼容）：**
```json
{
  "type": "subtask_start",
  "task_id": "task_1",    // ✨ 新增任务 ID
  "order": 1,
  "agent_name": "qa_agent",
  "description": "查询数据",
  "attempt": 1            // ✨ 新增重试次数
}
```

## 兼容性问题

### 问题 1：V2 没有发送 `task_analysis` 事件

**影响**：前端的任务分析卡片不会显示

**解决方案**：

#### 方案 A：修改 V2 保持兼容（推荐）

在 `master_agent_v2.py` 的 `stream_execute()` 中添加兼容事件：

```python
# 2. 发送执行计划
yield {
    'type': 'plan',
    'plan': plan.to_dict(),
    'mode': plan.mode.value,
    'subtask_count': len(plan.subtasks)
}

# ✨ 添加兼容 V1 的 task_analysis 事件
yield {
    'type': 'task_analysis',
    'complexity': plan.mode.value,  # 使用 mode 映射为 complexity
    'subtask_count': len(plan.subtasks),
    'reasoning': plan.reasoning
}
```

#### 方案 B：修改前端支持 V2

在 `ChatView.vue` 中添加 `plan` 事件处理：

```javascript
else if (data.type === 'plan') {
  currentMsg.taskAnalysis = {
    complexity: data.mode,  // mode 映射为 complexity
    subtask_count: data.subtask_count,
    reasoning: data.plan.reasoning,
    expanded: true
  };
}
```

### 问题 2：V2 的子任务事件缺少 `agent_display_name`

**影响**：前端可能显示技术名称而非友好名称

**解决方案**：

修改 `dag_executor.py` 的 `_execute_single_task()` 方法：

```python
if stream_callback:
    # 获取友好显示名称
    agent = self.orchestrator.agents.get(task.agent_name)
    agent_display_name = agent.agent_config.display_name if (agent and hasattr(agent, 'agent_config') and agent.agent_config) else task.agent_name

    stream_callback({
        'type': 'subtask_start',
        'task_id': task.id,
        'order': task.order,
        'agent_name': task.agent_name,
        'agent_display_name': agent_display_name,  # ✨ 添加友好名称
        'description': task.description,
        'attempt': attempt + 1
    })
```

### 问题 3：V2 新增的事件类型前端未处理

**影响**：新功能（状态更新、执行计划可视化）无法展示

**解决方案**：

#### 添加 `status` 事件处理

```javascript
else if (data.type === 'status') {
  currentMsg.status.push({ type: 'info', content: data.content });
}
```

#### 添加 `subtask_skipped` 事件处理

```javascript
else if (data.type === 'subtask_skipped') {
  const subtask = currentMsg.subtasks.find(s => s.task_id === data.task_id);
  if (subtask) {
    subtask.status = 'skipped';
    subtask.result_summary = data.reason;
  }
}
```

#### 添加 `execution_complete` 事件处理

```javascript
else if (data.type === 'execution_complete') {
  // 显示执行摘要
  currentMsg.executionSummary = {
    success: data.success,
    total_tasks: data.summary.total_tasks,
    completed_tasks: data.summary.completed_tasks,
    failed_tasks: data.summary.failed_tasks,
    execution_time: data.summary.execution_time
  };
}
```

## 推荐的集成方案

### 方案 1：最小化改动（推荐）

**只修改后端 V2，保持前端不变**

1. 在 V2 的 `stream_execute()` 中添加兼容 V1 的事件
2. 在 DAGExecutor 中添加 `agent_display_name`
3. 前端无需任何改动即可使用

**优点**：
- ✅ 前端无需改动
- ✅ 快速上线
- ✅ V1 和 V2 可以共存

**缺点**：
- ❌ V2 的新特性（DAG 可视化、状态更新）无法展示

### 方案 2：渐进式增强

**先兼容，再逐步添加新特性**

**阶段 1：保证基本兼容**
1. V2 发送兼容 V1 的事件
2. 前端正常工作

**阶段 2：添加新特性支持**
1. 前端添加 `plan` 事件处理，展示 DAG 可视化
2. 前端添加 `status` 事件处理，显示状态更新
3. 前端添加执行摘要组件

**优点**：
- ✅ 可以分阶段实施
- ✅ 风险可控
- ✅ 逐步释放 V2 的能力

**缺点**：
- ❌ 需要前端改动

### 方案 3：完整重构

**充分利用 V2 的所有特性**

1. 前端完全重写事件处理逻辑
2. 添加 DAG 可视化组件（使用 ECharts 或 Vue Flow）
3. 添加实时状态面板
4. 添加执行计划审核界面

**优点**：
- ✅ 充分利用 V2 能力
- ✅ 更好的用户体验

**缺点**：
- ❌ 工作量大
- ❌ 风险高

## 立即可用的修复

为了让 V2 **立即可用**，我已经准备好以下修复补丁：

### 补丁 1：V2 兼容 V1 事件

在 `backend/agents/master_agent_v2/master_agent_v2.py` 的第 298 行后添加：

```python
# 2. 发送执行计划
yield {
    'type': 'plan',
    'plan': plan.to_dict(),
    'mode': plan.mode.value,
    'subtask_count': len(plan.subtasks)
}

# ✨ 兼容 V1：发送 task_analysis 事件
yield {
    'type': 'task_analysis',
    'complexity': plan.mode.value,
    'subtask_count': len(plan.subtasks),
    'reasoning': plan.reasoning
}
```

### 补丁 2：DAGExecutor 添加 display_name

在 `backend/agents/master_agent_v2/dag_executor.py` 的第 271 行后添加：

```python
# 获取友好显示名称
agent = self.orchestrator.agents.get(task.agent_name)
agent_display_name = task.agent_name
if agent and hasattr(agent, 'agent_config') and agent.agent_config:
    agent_display_name = agent.agent_config.display_name or task.agent_name

if stream_callback:
    stream_callback({
        'type': 'subtask_start',
        'task_id': task.id,
        'order': task.order,
        'agent_name': task.agent_name,
        'agent_display_name': agent_display_name,  # ✨ 添加
        'description': task.description,
        'attempt': attempt + 1
    })
```

## 测试检查清单

应用补丁后，测试以下场景：

- [ ] 简单任务：单智能体执行
- [ ] 顺序任务：多智能体按顺序执行
- [ ] 并行任务：多智能体并行执行
- [ ] 任务分析卡片正常显示
- [ ] 子任务卡片正常显示
- [ ] 工具调用正常显示
- [ ] 最终答案正常显示
- [ ] 图表/地图正常渲染

## 总结

**✅ MasterAgent V2 可以与现有前端兼容**

通过以下两个小补丁：
1. 添加兼容 V1 的 `task_analysis` 事件
2. 添加 `agent_display_name` 字段

V2 即可无缝集成到现有系统，前端无需任何改动。

**后续优化建议**：
- 前端添加 DAG 可视化组件，展示执行计划
- 前端添加实时状态面板，显示并行任务进度
- 前端添加执行摘要卡片，显示性能指标

这些优化可以在 V2 稳定运行后逐步实施。

# MasterAgent V2 前端集成指南

## 新组件概览

为 MasterAgent V2 开发了 3 个全新的前端组件：

### 1. ExecutionPlanCard.vue - 执行计划可视化

**功能**：
- 展示 V2 的执行计划（simple/sequential/parallel/dag）
- DAG 可视化（节点-边图）
- 自动布局和拓扑排序
- 实时状态更新

**使用**：
```vue
<ExecutionPlanCard :plan="msg.executionPlan" />
```

**数据格式**：
```javascript
{
  mode: 'parallel',  // simple/sequential/parallel/dag
  reasoning: '分析原因...',
  subtasks: [
    {
      id: 'task_1',
      order: 1,
      description: '任务描述',
      agent_name: 'qa_agent',
      status: 'running',  // pending/running/completed/failed
      depends_on: []
    }
  ],
  dag: {
    nodes: [{ id: 'task_1', label: 'qa_agent', ... }],
    edges: [{ from: 'task_1', to: 'task_2' }]
  }
}
```

### 2. ParallelStatusPanel.vue - 并行任务状态面板

**功能**：
- 实时展示多个并行执行的任务
- 卡片网格布局
- 当前动作追踪（思考/工具调用）
- 已完成任务折叠列表

**使用**：
```vue
<ParallelStatusPanel :subtasks="msg.subtasks" />
```

**触发条件**：
- 当检测到 2 个或以上任务同时处于 `running` 状态时自动显示

### 3. ExecutionSummaryCard.vue - 执行摘要卡片

**功能**：
- 展示执行统计（总任务/完成/失败）
- 性能指标（总耗时/并行效率/平均耗时）
- 成功率进度条
- 视觉化的指标面板

**使用**：
```vue
<ExecutionSummaryCard :summary="msg.executionSummary" />
```

**数据格式**：
```javascript
{
  success: true,
  total_tasks: 5,
  completed_tasks: 5,
  failed_tasks: 0,
  skipped_tasks: 0,
  execution_time: 12.5,
  parallel_efficiency: 60  // 可选，并行效率百分比
}
```

## 集成到 ChatView.vue

### 方案 A：创建新的 ChatViewV2.vue（推荐）

保留原有 `ChatView.vue`，创建新的 `ChatViewV2.vue`，用户可选择使用哪个版本。

#### 步骤 1：复制并修改

```bash
cp frontend-client/src/views/ChatView.vue frontend-client/src/views/ChatViewV2.vue
```

#### 步骤 2：添加新组件导入

在 `ChatViewV2.vue` 的 `<script setup>` 中添加：

```javascript
import ExecutionPlanCard from '../components/ExecutionPlanCard.vue';
import ParallelStatusPanel from '../components/ParallelStatusPanel.vue';
import ExecutionSummaryCard from '../components/ExecutionSummaryCard.vue';
```

#### 步骤 3：修改数据结构

在 `handleSend()` 中，初始化消息时添加：

```javascript
const assistantMsgIndex = messages.value.push({
  role: 'assistant',
  content: '',
  taskAnalysis: null,
  executionPlan: null,        // ✨ 新增
  subtasks: [],
  showFullSubtasks: false,
  multimodalContents: [],
  executionSummary: null,     // ✨ 新增
  status: []
}) - 1;
```

#### 步骤 4：处理新事件类型

在 SSE 事件处理循环中添加：

```javascript
// 处理 plan 事件（V2 专属）
else if (data.type === 'plan') {
  currentMsg.executionPlan = data.plan;
}

// 处理 execution_complete 事件（V2 专属）
else if (data.type === 'execution_complete') {
  currentMsg.executionSummary = data.summary;
}

// 处理 status 事件（V2 专属）
else if (data.type === 'status') {
  currentMsg.status.push({ type: 'info', content: data.content });
}

// 处理 subtask_skipped 事件（V2 专属）
else if (data.type === 'subtask_skipped') {
  const subtask = currentMsg.subtasks.find(s => s.task_id === data.task_id);
  if (subtask) {
    subtask.status = 'skipped';
    subtask.result_summary = data.reason;
  }
}
```

#### 步骤 5：添加组件到模板

在 `<template>` 中，消息内容区域添加：

```vue
<!-- 执行计划（V2 特性） -->
<ExecutionPlanCard
  v-if="msg.executionPlan"
  :plan="msg.executionPlan"
/>

<!-- 并行任务状态面板（V2 特性） -->
<ParallelStatusPanel
  v-if="msg.subtasks && msg.subtasks.length > 0"
  :subtasks="msg.subtasks"
/>

<!-- 保留原有的子任务详情 -->
<div v-if="msg.subtasks && msg.subtasks.length > 0" class="subtasks-container">
  <!-- ... 原有代码 ... -->
</div>

<!-- 执行摘要（V2 特性） -->
<ExecutionSummaryCard
  v-if="msg.executionSummary"
  :summary="msg.executionSummary"
/>
```

#### 步骤 6：调整 API 端点

如果需要明确使用 V2，修改请求：

```javascript
const response = await fetch('/api/agent/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    task: content,
    session_id: null,
    use_v2: true  // ✨ 明确使用 V2
  })
});
```

### 方案 B：直接修改现有 ChatView.vue

如果想直接升级现有页面，按照上述步骤 2-5 修改即可。

**优点**：
- 所有用户自动使用 V2
- 只维护一套代码

**缺点**：
- V1 特性不再可用
- 需要确保后端 V2 稳定

## 完整的消息显示顺序（推荐）

```vue
<div class="message-content">
  <!-- 1. Loading State -->
  <div v-if="isLoading" class="loading-indicator">...</div>

  <!-- 2. 任务分析（兼容 V1） -->
  <TaskAnalysisCard v-if="msg.taskAnalysis" :taskAnalysis="msg.taskAnalysis" />

  <!-- 3. 执行计划（V2 新增） -->
  <ExecutionPlanCard v-if="msg.executionPlan" :plan="msg.executionPlan" />

  <!-- 4. 并行任务面板（V2 新增，动态显示） -->
  <ParallelStatusPanel
    v-if="hasParallelTasks(msg.subtasks)"
    :subtasks="msg.subtasks"
  />

  <!-- 5. 子任务详情（兼容 V1） -->
  <SubtaskStatusTicker v-if="msg.subtasks" :subtasks="msg.subtasks" />

  <!-- 6. 多模态内容（图表/地图） -->
  <MultimodalContent v-if="msg.multimodalContents" :contents="msg.multimodalContents" />

  <!-- 7. 最终答案 -->
  <div v-if="msg.content" class="final-answer">...</div>

  <!-- 8. 执行摘要（V2 新增） -->
  <ExecutionSummaryCard v-if="msg.executionSummary" :summary="msg.executionSummary" />

  <!-- 9. 状态消息 -->
  <div v-if="msg.status" class="status-updates">...</div>
</div>
```

## 辅助函数

添加到 `<script setup>` 中：

```javascript
// 判断是否有并行任务
const hasParallelTasks = (subtasks) => {
  if (!subtasks) return false;
  const running = subtasks.filter(t => t.status === 'running');
  return running.length > 1;
};
```

## 版本切换开关

### 在 Sidebar 中添加版本切换

```vue
<div class="sidebar-footer">
  <div class="version-toggle">
    <label>
      <input type="checkbox" v-model="useV2" />
      <span>使用 MasterAgent V2</span>
    </label>
    <span class="version-badge">{{ useV2 ? 'V2' : 'V1' }}</span>
  </div>
</div>
```

### 动态 API 端点

```javascript
const useV2 = ref(false);  // 或从 localStorage 读取

const response = await fetch('/api/agent/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    task: content,
    session_id: null,
    use_v2: useV2.value  // 动态切换
  })
});
```

## CSS 变量（确保已定义）

新组件使用了以下 CSS 变量，确保在全局样式中定义：

```css
:root {
  --color-primary: #3b82f6;
  --color-primary-hover: #2563eb;
  --color-primary-subtle: #eff6ff;
  --color-border: #e5e7eb;
  --color-border-hover: #d1d5db;
  --color-bg-elevated: #ffffff;
  --color-bg-secondary: #f9fafb;
  --color-bg-tertiary: #f3f4f6;
  --color-text-primary: #111827;
  --color-text-secondary: #6b7280;
  --color-text-muted: #9ca3af;
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;
  --glass-bg-light: rgba(255, 255, 255, 0.8);
  --glass-blur: 10px;
  --glass-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  --transition-fast: 0.15s ease;
  --transition-normal: 0.3s ease;
}
```

## 测试检查清单

集成后测试以下场景：

- [ ] 简单任务 - 单智能体执行
- [ ] 顺序任务 - 多个任务按顺序执行
- [ ] 并行任务 - 2+ 任务同时执行，ParallelStatusPanel 自动显示
- [ ] 执行计划可视化 - DAG 图正确渲染
- [ ] 任务状态更新 - 节点颜色实时变化
- [ ] 执行摘要显示 - 性能指标正确
- [ ] 版本切换 - V1/V2 可以切换
- [ ] 响应式布局 - 移动端正常显示

## 已知限制

1. **DAG 可视化**：当任务数超过 10 个时，布局可能拥挤，建议折叠或分页
2. **并行面板**：最多显示 6 个并行任务卡片，更多任务会滚动
3. **浏览器兼容性**：需要支持 CSS Grid 和 Backdrop Filter

## 文件清单

新创建的文件：

```
frontend-client/src/components/
├── ExecutionPlanCard.vue         # 执行计划可视化
├── ParallelStatusPanel.vue       # 并行任务状态
└── ExecutionSummaryCard.vue      # 执行摘要

frontend-client/src/views/
└── ChatViewV2.vue (可选)         # V2 专用页面
```

## 下一步

1. 按照上述步骤集成新组件
2. 在开发环境测试所有场景
3. 调整样式以匹配现有设计系统
4. 添加用户偏好存储（V1/V2 选择）
5. 准备部署到生产环境

---

**注意**：所有新组件都是响应式的，支持深色模式（如果项目有），并且性能优化（使用 `computed` 和 `watch`）。

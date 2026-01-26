# MasterAgent V2 前端使用指南

## 🎉 V2 前端已集成完成

V1 和 V2 现在可以通过前端界面一键切换，无需修改任何代码！

---

## 📍 文件清单

### 新增文件
1. **`src/views/ChatViewV2.vue`** - V2 专用页面（带并行执行、DAG 可视化等新特性）
2. **`V2_USAGE_GUIDE.md`** - 本使用指南

### 修改文件
1. **`src/App.vue`** - 添加版本切换按钮和逻辑
2. **`src/views/ChatView.vue`** - 移除误添加的 V2 组件导入（恢复纯 V1）

### 保留文件（无需修改）
- `src/components/ExecutionPlanCard.vue`
- `src/components/ParallelStatusPanel.vue`
- `src/components/ExecutionSummaryCard.vue`
- `INTEGRATION_GUIDE.md`
- `V2_FRONTEND_COMPLETION_REPORT.md`

---

## 🚀 快速开始

### 1. 启动前端
```bash
cd frontend-client
npm run dev
```

### 2. 切换到 V2
在浏览器界面右上角，点击 **V1/V2** 按钮即可切换版本：
- **V1** - 原始版本（顺序执行，传统 UI）
- **V2** - 增强版本（并行执行，DAG 可视化，性能指标）

### 3. 测试 V2 特性
切换到 V2 后，发送一个需要多个任务的问题，例如：
```
查询广西2021年、2022年、2023年的台风数据并对比分析
```

**V2 将自动显示**：
- 📊 **执行计划卡片** - 显示 DAG 图和任务依赖关系
- ⚡ **并行状态面板** - 实时显示多个并行任务（当检测到 2+ 任务同时运行时自动出现）
- 📈 **执行摘要卡片** - 显示性能指标（总耗时、并行效率、成功率等）

---

## 🎨 V2 界面特性

### 欢迎界面
V2 的欢迎界面展示了新特性标签：
- ⚡ Parallel Execution
- 📊 DAG Visualization
- 🔄 Auto Retry
- 📈 Performance Metrics

### Sidebar 版本标识
V2 页面左侧 Sidebar 顶部有紫色渐变的版本标识：
```
V2
Enhanced with DAG execution
```

---

## 🔧 技术细节

### 版本切换机制

**前端实现** (`src/App.vue`):
```vue
<ChatView v-if="!useV2" />
<ChatViewV2 v-else />
```

**偏好存储**:
- 版本选择保存在 `localStorage.useV2`
- 刷新页面后保持上次选择

### V2 API 请求
ChatViewV2 发送请求时会携带 `use_v2: true` 参数：
```javascript
fetch('/api/agent/stream', {
  method: 'POST',
  body: JSON.stringify({
    task: content,
    session_id: null,
    use_v2: true  // ✨ 明确使用 V2
  })
})
```

### V2 事件处理
V2 支持以下新事件类型：
- `plan` - 执行计划（触发 ExecutionPlanCard 显示）
- `status` - 状态消息（显示在底部状态栏）
- `subtask_skipped` - 任务跳过（显示跳过原因）
- `execution_complete` - 执行摘要（触发 ExecutionSummaryCard 显示）

---

## 📊 V2 vs V1 对比

| 特性 | V1 | V2 |
|------|----|----|
| 执行模式 | 顺序执行 | 并行 + DAG 执行 |
| 任务可视化 | 列表显示 | DAG 图 + 实时面板 |
| 性能指标 | ❌ | ✅ 总耗时、并行效率、成功率 |
| 失败重试 | ❌ | ✅ 自动重试（最多 1 次） |
| 任务状态 | running, success, error | pending, ready, running, completed, failed, skipped |
| 上下文管理 | 字符串拼接 | 结构化存储 |

---

## 🧪 测试场景

### 场景 1：简单查询（V2 自动降级到 simple 模式）
```
查询广西的灾害数据
```
**预期**: 不显示 DAG，只显示单个子任务卡片

### 场景 2：顺序任务（sequential 模式）
```
先查询广西2023年的台风数据，然后分析其影响
```
**预期**: 显示执行计划，任务按顺序执行

### 场景 3：并行任务（parallel 模式）
```
查询广西2021、2022、2023年的台风数据
```
**预期**:
- ✅ 显示执行计划（3个并行任务）
- ✅ 自动显示并行状态面板（3个卡片同时显示）
- ✅ 显示执行摘要（并行效率 ~60%）

### 场景 4：复杂 DAG（dag 模式）
```
查询南宁和柳州的灾害数据，分析各自的影响，然后汇总成一份报告
```
**预期**:
- ✅ 显示 DAG 图（第一层 2 个并行查询，第二层 2 个并行分析，第三层 1 个汇总）
- ✅ 并行面板显示同层任务
- ✅ 执行摘要显示总体性能

---

## 🛠️ 故障排查

### 1. 切换到 V2 后没有新特性显示
**原因**: 后端可能未启用 V2 或配置错误

**检查**:
```bash
cd backend
python -c "from agents.master_agent_v2 import MasterAgentV2; print('✅ V2 已加载')"
```

### 2. 并行面板不显示
**原因**: 并行面板只在检测到 2+ 任务同时 `running` 时才显示

**解决**:
- 尝试一个需要多个并行任务的问题
- 检查后端是否实际并行执行（查看 `plan.mode`）

### 3. DAG 图显示错乱
**原因**: 任务数量过多（> 10 个）或依赖关系复杂

**解决**:
- 调整 `ExecutionPlanCard.vue` 中的布局参数
- 或使用列表模式（折叠执行计划卡片）

### 4. 执行摘要不显示
**原因**: 后端未发送 `execution_complete` 事件

**检查**: 浏览器控制台查看 SSE 事件流，确认有 `type: 'execution_complete'` 事件

---

## 📖 参考文档

- **完整集成指南**: `INTEGRATION_GUIDE.md`
- **完成报告**: `V2_FRONTEND_COMPLETION_REPORT.md`
- **后端文档**: `backend/agents/master_agent_v2/README.md`
- **兼容性说明**: `backend/agents/master_agent_v2/FRONTEND_COMPATIBILITY.md`

---

## 🎯 下一步

1. **启动前端和后端**，测试版本切换功能
2. **尝试不同的查询**，观察 V2 的并行执行和可视化效果
3. **根据需要调整样式**，确保与整体设计一致
4. **性能测试**，验证 V2 的实际性能提升

---

## 💡 提示

- **版本切换立即生效**，无需刷新页面
- **偏好自动保存**，下次打开浏览器保持上次选择
- **V1 和 V2 完全隔离**，互不影响，可以随时切换
- **V2 向后兼容 V1 事件**，即使后端返回 V1 事件也能正常显示

---

**🎉 享受 MasterAgent V2 的全新体验！**

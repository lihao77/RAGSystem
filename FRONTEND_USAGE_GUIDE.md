# 前端新功能使用指南

## 快速开始

### 1. 启动服务

```bash
# 启动后端
cd backend
python app.py

# 启动前端（新终端）
cd frontend-client
npm run dev
```

访问: http://localhost:5173

### 2. 功能入口

#### 性能监控面板

**方式一**: 点击侧边栏"性能监控"按钮

**方式二**: 直接访问 http://localhost:5173/monitor

#### 用户审批对话框

自动触发，当智能体请求执行高风险工具时弹出。

---

## 功能详解

### 一、用户审批对话框

#### 触发条件

当智能体尝试执行以下高风险工具时：
- `execute_cypher_query` - 执行 Cypher 查询（可能修改数据）
- 其他配置为 `requires_approval: true` 的工具

#### 对话框内容

```
┌─────────────────────────────────────┐
│ ⚠️  权限确认                         │
├─────────────────────────────────────┤
│ 智能体: qa_agent                     │
│                                     │
│ 请求执行操作:                        │
│ 执行高风险工具: execute_cypher_query │
│                                     │
│ ⚠️ 此操作可能修改数据或执行敏感命令   │
│                                     │
│ 60秒后自动拒绝                       │
├─────────────────────────────────────┤
│         [拒绝]    [允许执行]         │
└─────────────────────────────────────┘
```

#### 操作说明

- **允许执行**: 智能体继续执行该工具
- **拒绝**: 智能体停止执行，返回错误信息
- **超时**: 60秒后自动拒绝

#### 测试示例

```
用户: 执行 Cypher 查询删除所有节点
```

系统会弹出审批对话框。

---

### 二、性能监控面板

#### 系统级指标

显示在页面顶部的卡片：

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ 智能体总数    │ 总调用次数    │ 平均耗时      │ 总体成功率    │
│     3        │    156       │   2.3s       │    94%       │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

#### 智能体详情

每个智能体显示：

**基本指标**:
- 成功率
- 调用次数
- 平均耗时
- 成功/失败次数
- 平均 Token 使用
- 首次/最近调用时间

**工具使用统计**:
```
query_knowledge_graph_with_nl  ████████████░░░░  89次
search_knowledge_graph         ████████░░░░░░░░  45次
find_causal_chain              ████░░░░░░░░░░░░  22次
```

**错误分布**:
```
LLMError              5次
ToolExecutionError    4次
```

#### 筛选功能

使用顶部下拉框筛选单个智能体：

```
[全部智能体 ▼]  [🔄 刷新]  [🗑️ 重置指标]
```

#### 操作按钮

- **刷新**: 重新加载最新指标数据
- **重置指标**: 清空所有性能数据（需确认）

---

## 配置说明

### 工具风险等级配置

在 `backend/tools/permissions.py` 中配置：

```python
TOOL_PERMISSIONS = {
    "query_knowledge_graph_with_nl": ToolPermission(
        tool_name="query_knowledge_graph_with_nl",
        risk_level=RiskLevel.LOW,        # 低风险，自动允许
        requires_approval=False
    ),
    "execute_cypher_query": ToolPermission(
        tool_name="execute_cypher_query",
        risk_level=RiskLevel.HIGH,       # 高风险，需要审批
        requires_approval=True
    )
}
```

### 智能体工具启用配置

在 `backend/agents/configs/agent_configs.yaml` 中配置：

```yaml
agents:
  qa_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl  # 启用低风险工具
        - search_knowledge_graph
        # execute_cypher_query 未启用（高风险工具）
```

---

## 故障排查

### 1. 审批对话框不弹出

**检查项**:
- 后端是否正常运行
- 工具是否配置为 `requires_approval: true`
- 浏览器控制台是否有错误
- SSE 连接是否正常

**解决方案**:
```bash
# 检查后端日志
tail -f backend/logs/app.log

# 检查浏览器控制台
F12 -> Console
```

### 2. 监控面板无数据

**原因**: 系统刚启动，还没有执行记录

**解决方案**:
1. 在聊天界面发送几条消息
2. 等待智能体执行完成
3. 刷新监控面板

### 3. API 调用失败

**检查项**:
- 后端是否启动
- 端口是否正确（默认 5000）
- CORS 配置是否正确

**测试 API**:
```bash
# 测试性能指标 API
curl http://localhost:5000/api/agent/metrics

# 运行测试脚本
python test_frontend_apis.py
```

---

## 开发调试

### 前端开发模式

```bash
cd frontend-client
npm run dev
```

修改代码后自动热重载。

### 查看网络请求

1. 打开浏览器开发者工具（F12）
2. 切换到 Network 标签
3. 筛选 XHR 请求
4. 查看 API 调用详情

### 查看 SSE 事件

在 ChatViewV2.vue 的 `handleSend` 函数中添加日志：

```javascript
console.log('SSE Event:', eventType, eventData);
```

---

## 最佳实践

### 1. 审批策略

**建议配置**:
- 只读操作（查询）: `requires_approval: false`
- 写操作（修改数据）: `requires_approval: true`
- 执行命令: `requires_approval: true`

### 2. 监控频率

**建议**:
- 开发环境: 每次执行后查看
- 生产环境: 每天查看一次
- 出现问题时: 立即查看

### 3. 指标重置

**建议**:
- 定期重置（每周/每月）
- 重大更新后重置
- 性能测试前重置

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| 无 | 当前版本暂无快捷键 |

---

## 相关文档

- [后端权限控制指南](backend/agents/docs/guides/PERMISSIONS.md)
- [后端可观测性指南](backend/agents/docs/guides/OBSERVABILITY.md)
- [系统升级总结](backend/agents/docs/AGENT_SYSTEM_UPGRADE_SUMMARY.md)

---

## 反馈与支持

如有问题或建议，请：
1. 查看相关文档
2. 检查浏览器控制台错误
3. 查看后端日志
4. 提交 Issue

---

**最后更新**: 2026-02-23
**版本**: 1.0.0

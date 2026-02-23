# 智能体系统权限控制指南

## 概述

RAGSystem 智能体系统提供完整的权限控制机制，包括工具风险等级标记、执行前权限验证和用户审批流程。

## 核心组件

### 1. 工具权限系统

**位置**: `backend/tools/permissions.py`

**功能**:
- 工具风险等级定义
- 权限检查
- 用户审批控制

**风险等级**:

```python
class RiskLevel(Enum):
    LOW = "low"          # 低风险：只读操作，无副作用
    MEDIUM = "medium"    # 中风险：可能影响性能或返回大量数据
    HIGH = "high"        # 高风险：写操作、删除操作、执行外部命令
```

**工具权限配置**:

```python
from tools.permissions import ToolPermission, RiskLevel

# 低风险工具（只读）
query_kg_permission = ToolPermission(
    tool_name="query_knowledge_graph_with_nl",
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    description="自然语言查询知识图谱（只读）"
)

# 高风险工具（需审批）
execute_cypher_permission = ToolPermission(
    tool_name="execute_cypher_query",
    risk_level=RiskLevel.HIGH,
    requires_approval=True,
    description="执行 Cypher 查询（可能修改数据）"
)
```

### 2. 权限检查

**在工具执行前自动检查**:

```python
from tools.permissions import check_tool_permission

# 检查权限
allowed, error_msg = check_tool_permission(
    tool_name="execute_cypher_query",
    agent_config=agent_config,
    user_role="admin"
)

if not allowed:
    return {"success": False, "error": error_msg}
```

**检查逻辑**:

1. 检查工具是否存在
2. 检查工具是否在智能体配置中启用
3. 检查用户角色是否有权限
4. 检查是否需要用户审批

### 3. 工具配置

**在智能体配置中启用工具**:

```yaml
# backend/agents/configs/agent_configs.yaml
agents:
  qa_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl  # 低风险，自动允许
        - search_knowledge_graph          # 低风险，自动允许
        - find_causal_chain               # 中风险，自动允许
        # execute_cypher_query 未启用，将被拒绝
```

## 工具风险等级分类

### 低风险工具（LOW）

**特征**: 只读操作，无副作用

**工具列表**:
- `query_knowledge_graph_with_nl` - 自然语言查询
- `search_knowledge_graph` - 搜索实体
- `get_entity_relations` - 获取关系
- `get_graph_schema` - 获取图谱结构
- `compare_entities` - 比较实体
- `aggregate_statistics` - 聚合统计
- `generate_chart` - 生成图表
- `generate_map` - 生成地图
- `query_emergency_plan` - 查询应急预案
- `get_entity_geometry` - 获取几何数据

**权限配置**:
```python
requires_approval = False  # 无需审批
```

### 中风险工具（MEDIUM）

**特征**: 可能影响性能或返回大量数据

**工具列表**:
- `analyze_temporal_pattern` - 时序模式分析
- `find_causal_chain` - 因果链分析
- `get_spatial_neighbors` - 空间邻近分析
- `load_skill_resource` - 加载 Skill 资源

**权限配置**:
```python
requires_approval = False  # 通常无需审批，但可配置
```

### 高风险工具（HIGH）

**特征**: 写操作、删除操作、执行外部命令

**工具列表**:
- `execute_cypher_query` - 执行 Cypher 查询（可能修改数据）
- `process_data_file` - 处理数据文件（可能修改文件系统）
- `transform_data` - 数据转换（可能修改数据）
- `execute_skill_script` - 执行 Skill 脚本（可能执行任意代码）

**权限配置**:
```python
requires_approval = True  # 需要用户审批
```

## 用户审批流程

### 1. 后端发布审批请求

当工具需要审批时，后端发布 `USER_APPROVAL_REQUIRED` 事件：

```python
# backend/tools/tool_executor.py
if permission.requires_approval:
    event_bus.publish(
        EventType.USER_APPROVAL_REQUIRED,
        {
            "tool_name": tool_name,
            "arguments": arguments,
            "risk_level": permission.risk_level.value,
            "description": permission.description
        }
    )
```

### 2. 前端监听审批事件

前端通过 SSE 流监听审批请求：

```javascript
// frontend-client/src/views/Chat.vue
eventSource.addEventListener('USER_APPROVAL_REQUIRED', (event) => {
  const data = JSON.parse(event.data);

  // 显示审批对话框
  showApprovalDialog({
    toolName: data.tool_name,
    arguments: data.arguments,
    riskLevel: data.risk_level,
    description: data.description
  });
});
```

### 3. 用户确认或拒绝

```vue
<el-dialog title="权限确认" v-model="approvalDialogVisible">
  <p>智能体请求执行以下操作：</p>
  <p class="tool-name">{{ toolName }}</p>
  <p class="description">{{ description }}</p>
  <p class="warning">⚠️ 此操作可能修改数据，请谨慎确认。</p>

  <template #footer>
    <el-button @click="denyApproval">拒绝</el-button>
    <el-button type="primary" @click="grantApproval">允许</el-button>
  </template>
</el-dialog>
```

### 4. 响应审批结果

```javascript
// 允许执行
async function grantApproval() {
  await api.post(`/api/agent/approvals/${approvalId}/respond`, {
    approved: true
  });
  approvalDialogVisible.value = false;
}

// 拒绝执行
async function denyApproval() {
  await api.post(`/api/agent/approvals/${approvalId}/respond`, {
    approved: false
  });
  approvalDialogVisible.value = false;
}
```

## 权限配置示例

### 示例 1：限制工具使用

```yaml
# 只允许使用低风险工具
agents:
  safe_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        - search_knowledge_graph
        - get_entity_relations
```

### 示例 2：允许高风险工具（需审批）

```yaml
# 允许使用高风险工具，但需要用户审批
agents:
  admin_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        - execute_cypher_query  # 高风险，需审批
        - process_data_file     # 高风险，需审批
```

### 示例 3：角色权限控制

```python
# backend/tools/permissions.py
TOOL_PERMISSIONS = {
    "execute_cypher_query": ToolPermission(
        tool_name="execute_cypher_query",
        risk_level=RiskLevel.HIGH,
        requires_approval=True,
        allowed_roles=["admin", "developer"]  # 只允许管理员和开发者
    )
}
```

## 权限检查流程

```
用户请求
    ↓
智能体选择工具
    ↓
权限检查（check_tool_permission）
    ├─ 工具是否存在？
    ├─ 工具是否在智能体配置中启用？
    ├─ 用户角色是否有权限？
    └─ 是否需要用户审批？
        ↓
    需要审批
        ↓
    发布 USER_APPROVAL_REQUIRED 事件
        ↓
    前端显示审批对话框
        ↓
    用户确认/拒绝
        ↓
    继续执行/停止执行
```

## 最佳实践

### 1. 工具分类

```python
# ✅ 好的做法：明确标记工具风险等级
@tool(risk_level=RiskLevel.HIGH, requires_approval=True)
def delete_entity(entity_id):
    # 删除操作，高风险
    pass

@tool(risk_level=RiskLevel.LOW, requires_approval=False)
def query_entity(entity_id):
    # 查询操作，低风险
    pass
```

### 2. 最小权限原则

```yaml
# ✅ 好的做法：只启用必需的工具
agents:
  qa_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl  # 核心功能
        - search_knowledge_graph          # 核心功能
        # 不启用不必要的高风险工具
```

### 3. 审批超时

```python
# ✅ 好的做法：设置审批超时时间
approval_timeout = 60  # 60 秒

if not wait_for_approval(timeout=approval_timeout):
    return {"success": False, "error": "审批超时"}
```

## 故障排查

### 问题：工具被拒绝执行

**错误消息**: "工具 xxx 未在智能体配置中启用"

**解决方案**:
1. 检查智能体配置文件 `agent_configs.yaml`
2. 确认工具在 `enabled_tools` 列表中
3. 重启后端或调用 `/api/agent-config/reload`

### 问题：审批对话框未显示

**原因**: 前端未监听 `USER_APPROVAL_REQUIRED` 事件

**解决方案**:
1. 检查前端 SSE 连接是否正常
2. 检查事件监听器是否正确注册
3. 查看浏览器控制台错误

### 问题：审批后工具仍未执行

**原因**: 审批响应未正确处理

**解决方案**:
1. 检查审批 API 响应状态
2. 确认后端收到审批结果
3. 查看后端日志

## 安全建议

### 1. 生产环境配置

```yaml
# 生产环境：严格限制高风险工具
agents:
  production_agent:
    tools:
      enabled_tools:
        - query_knowledge_graph_with_nl
        - search_knowledge_graph
        # 禁用所有高风险工具
```

### 2. 审计日志

```python
# 记录所有工具执行
logger.info("tool_execution",
    tool_name=tool_name,
    user_id=user_id,
    approved=approved,
    risk_level=risk_level
)
```

### 3. 定期审查

- 定期审查工具权限配置
- 检查审批日志
- 更新风险等级评估

## 相关文档

- [可观测性指南](OBSERVABILITY.md)
- [错误处理指南](ERROR_HANDLING.md)
- [智能体配置指南](../AGENT_CONFIG_GUIDE.md)

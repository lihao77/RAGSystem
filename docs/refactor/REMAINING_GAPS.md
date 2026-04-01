# 工具体系剩余差距清单（2026-04-01）

> **当前对标度**：~75%
>
> **核心架构**：已对齐 Claude Code
>
> **剩余差距**：主要为工程细节和可选优化

---

## 一、架构层面差距（影响核心能力）

### 1. Hooks 系统 ⚠️ 高优先级（按需）

**当前状态**：已移除空壳骨架

**Claude Code 实现**：
- 从 `settings.json` 读取 hook 配置
- 真实的 shell 命令执行系统（spawn 子进程）
- Hook registry + priority + per-tool pattern 过滤
- 支持 before/after/error 等生命周期阶段

**差距**：
- 无 hook 配置读取机制
- 无 shell 命令执行能力
- 无 hook registry 和优先级管理
- 无 per-tool pattern 过滤

**影响**：
- 无法通过配置文件自定义工具执行前后的行为
- 无法实现审计、参数重写、结果后处理等扩展能力

**实现建议**：
```python
# settings.json 示例
{
  "hooks": {
    "before_tool_execute": [
      {
        "pattern": "execute_bash",
        "command": "echo 'Executing bash command'",
        "priority": 10
      }
    ],
    "after_tool_execute": [
      {
        "pattern": "*",
        "command": "audit-tool-call.sh",
        "priority": 100
      }
    ]
  }
}
```

**参考文件**：
- Claude Code: `src/core/hooks/HookManager.ts`
- 当前系统：已移除 `tools/runtime/executor.py::_run_hooks`

---

### 2. 大结果落盘闭环 🔧 中优先级（按需）

**当前状态**：已移除 executor 里的落盘逻辑

**Claude Code 实现**：
- 在查询边界（发送给 LLM 前）通过 `enforceToolResultBudget` 统一处理
- 超过阈值的结果自动落盘到文件
- 返回文件引用 + preview 给 LLM
- 提供标准回读 API

**差距**：
- 无统一的结果大小判定规则
- 无查询边界的自动落盘机制
- 无标准的结果引用协议（除了 artifact）
- 无通用的结果回读 API

**影响**：
- 大结果可能导致 LLM 上下文溢出
- 无法统一管理工具结果的持久化
- 前端回读结果依赖具体子域实现

**实现建议**：
```python
# 在 base.py 发送给 LLM 前
def _prepare_tool_results_for_llm(results):
    for result in results:
        if len(str(result.content)) > MAX_RESULT_SIZE:
            # 落盘到 data/sessions/{session_id}/tool_results/{result_id}.json
            ref = materialize_large_result(result)
            result.content = {
                "type": "file_ref",
                "ref": ref,
                "preview": str(result.content)[:500]
            }
    return results
```

**参考文件**：
- Claude Code: `src/core/tools/enforceToolResultBudget.ts`
- 当前系统：已移除 `tools/refs/result_references.py::_materialize_result_envelope`

---

## 二、体验层面差距（影响用户感知）

### 3. 可观测语义统一 🔧 低优先级（体验优化）

**当前状态**：direct/skill 在前端展示上仍有两层

**问题描述**：
- 前端某些场景看到的是 `execute_skill_script`
- 用户期望看到的是具体的工具语义（如 `create_chart`）

**差距**：
- 事件结构中 `tool_name` 仍是底层实现名称
- 缺少 `display_name` 或 `semantic_name` 字段
- 前端 projector 无法区分底层调用和用户语义

**影响**：
- 用户在执行树中看到技术细节而非业务语义
- 调试时难以理解工具调用链

**实现建议**：
```python
# 在 execute_skill_script 中
result.metadata['semantic_tool_name'] = f"{skill_name}::{script_name}"
result.metadata['display_name'] = "创建图表"

# 前端 projector
const displayName = step.metadata?.display_name || step.tool_name
```

**参考文件**：
- 当前系统：`tools/local/skill_tools.py::execute_skill_script`
- 前端：`frontend-client/src/utils/executionProjector.js`

---

### 4. MCP 工具细粒度权限 🔧 低优先级（安全增强）

**当前状态**：MCP 权限仍偏 server 级

**问题描述**：
- 当前只能启用/禁用整个 MCP server
- 无法针对单个 MCP 工具设置权限

**差距**：
- `mcp.enabled_servers` 是 server 级别的
- 无 `mcp.enabled_tools` 或 `mcp.disabled_tools` 配置
- 无法为单个 MCP 工具设置不同的 risk_level

**影响**：
- 启用一个 server 就暴露了所有工具
- 无法精细控制 MCP 工具的访问权限

**实现建议**：
```yaml
# agent_configs.yaml
mcp:
  enabled_servers:
    - filesystem
  tool_overrides:
    mcp__filesystem__delete_file:
      enabled: false
      reason: "Too dangerous for this agent"
    mcp__filesystem__read_file:
      risk_level: low
```

**参考文件**：
- 当前系统：`tools/runtime/exposure.py::get_tool_exposure_decision`
- 当前系统：`tools/permissions.py::evaluate_tool_permission`

---

## 三、性能优化差距（非功能性）

### 5. Exposure 缓存 🔧 低优先级（性能优化）

**当前状态**：已优化为快速路径，但无缓存

**问题描述**：
- 每次 `execute_tool` 都调用 `get_tool_exposure_decision`
- 虽然是快速路径，但仍有重复计算

**差距**：
- 无 agent_config 级别的 LRU 缓存
- 无缓存失效机制（MCP 工具动态变化时）

**影响**：
- 高频工具调用时有轻微性能损耗
- 对大多数场景影响不大

**实现建议**：
```python
from functools import lru_cache

@lru_cache(maxsize=1024)
def _cached_exposure_decision(tool_name: str, agent_config_id: str):
    return get_tool_exposure_decision(tool_name, agent_config)

# 注意：需要处理 MCP 工具动态性
```

**参考文件**：
- 当前系统：`tools/runtime/exposure.py::get_tool_exposure_decision`

---

### 6. PermissionDecision 扩展字段 🔧 低优先级（可扩展性）

**当前状态**：已精简为三态，但缺少扩展点

**问题描述**：
- 当前 `PermissionDecision` 只有核心决策字段
- 未来如需更细粒度的权限元数据（如 hook 来源、classifier 结果），缺少扩展点

**差距**：
- 无 `metadata` 字段用于扩展
- `resolved_from` 只是字符串列表，无法携带复杂信息

**影响**：
- 未来扩展权限系统时可能需要修改数据结构

**实现建议**：
```python
@dataclass
class PermissionDecision:
    # ... 现有字段 ...
    metadata: Dict[str, Any] = field(default_factory=dict)  # 扩展点
```

**参考文件**：
- 当前系统：`tools/runtime/models.py::PermissionDecision`

---

## 四、文档和测试差距

### 7. 工具执行流程可视化 📝 低优先级（文档增强）

**当前状态**：有详细文档但缺少流程图

**差距**：
- `TOOL_WORKFLOW.md` 是纯文本（512 行）
- 缺少 Mermaid 流程图或架构图
- 新人理解成本较高

**实现建议**：
```markdown
## 工具执行流程图

\`\`\`mermaid
graph TD
    A[Agent.execute] --> B[BaseAgent._handle_actions]
    B --> C[execute_tool]
    C --> D[ToolUseContext 构建]
    D --> E[request_user_approval_if_needed]
    E --> F{需要审批?}
    F -->|是| G[发布 USER_APPROVAL_REQUIRED]
    F -->|否| H[get_tool_handler]
    ...
\`\`\`
```

**参考文件**：
- 当前系统：`docs/refactor/TOOL_WORKFLOW.md`

---

### 8. 集成测试覆盖 🧪 低优先级（测试增强）

**当前状态**：单元测试较完善，集成测试不足

**差距**：
- 缺少端到端的工具执行流程测试
- 缺少 MCP 工具的集成测试
- 缺少审批流程的集成测试

**实现建议**：
```python
# tests/integration/test_tool_execution_e2e.py
def test_tool_execution_with_approval():
    # 模拟完整的工具执行流程
    # 包括审批等待、超时、取消等场景
    pass
```

**参考文件**：
- 当前系统：`agents/tests/test_core/`

---

## 五、总结

### 按优先级分类

| 优先级 | 差距项 | 影响范围 | 实现成本 |
|--------|--------|----------|----------|
| ⚠️ 高（按需） | Hooks 系统 | 扩展能力 | 中 |
| 🔧 中（按需） | 大结果落盘闭环 | 上下文管理 | 中 |
| 🔧 低（体验） | 可观测语义统一 | 用户体验 | 低 |
| 🔧 低（安全） | MCP 细粒度权限 | 安全控制 | 低 |
| 🔧 低（性能） | Exposure 缓存 | 性能优化 | 低 |
| 🔧 低（扩展） | PermissionDecision 扩展 | 可扩展性 | 低 |
| 📝 低（文档） | 流程可视化 | 文档质量 | 低 |
| 🧪 低（测试） | 集成测试覆盖 | 测试质量 | 中 |

### 核心结论

1. **架构层面**：核心架构已对齐 Claude Code（~75%），剩余主要是 Hooks 和大结果落盘两个可选特性
2. **体验层面**：可观测语义和 MCP 权限是体验优化项，不影响核心功能
3. **性能层面**：当前性能已足够，缓存优化是锦上添花
4. **文档测试**：文档已较完善，可视化和集成测试是增强项

### 实施建议

- **短期**：保持当前架构，按需实现 Hooks 或大结果落盘
- **中期**：优化可观测语义和 MCP 权限，提升用户体验
- **长期**：完善文档可视化和集成测试，提升项目质量

---

**最后更新**：2026-04-01

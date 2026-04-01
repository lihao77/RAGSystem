# 工具体系剩余差距清单（2026-04-01）

> **当前对标度**：~85%（从 ~75% 提升，大结果落盘闭环已完成）
>
> **核心架构**：已基本对齐 Claude Code
>
> **当前优先级**：P3 Hooks → P4 可观测语义统一 → P5 MCP 细粒度权限 / 缓存等可选增强

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

### 2. 大结果落盘闭环 ✅ 已完成

**当前状态**：已有完整的 observation-based 大结果落盘机制

**实现情况**：
- ✅ `ObservationPolicy` 决策系统（inline / artifact_ref 两阶段）
- ✅ `ArtifactStore` 持久化层（save_json / save_text）
- ✅ `LargePayloadFormatter` 格式化器（自动落盘 + 预览）
- ✅ 基于预算的阈值判定（compact/balanced/expansive）
- ✅ TTL 管理和自动清理
- ✅ 索引文件（artifact_index.jsonl）
- ✅ 存储路径：`data/sessions/{session_id}/transient/data_*.json`

**决策规则**：
```python
# ObservationPolicy.decide()
1. force_artifact → artifact_ref（强制落盘）
2. error → inline（错误始终内联）
3. chart/map → inline（可视化内联）
4. skills 文档工具 → inline（激活文档需完整注入）
5. read_file → inline（不重复落盘）
6. 大小判定：
   - text: <= 1600 chars → inline
   - json: <= 2400 chars → inline
   - geojson: <= 960 chars → inline（降低阈值）
   - 超过阈值 → artifact_ref
```

**落盘流程**：
```
BaseAgent._format_tool_observation()
  → ObservationPolicy.decide() → ObservationDecision(mode="artifact_ref")
  → LargePayloadFormatter.format()
    → ArtifactStore.save_json/save_text()
    → 返回文件引用 + 预览 + 数据结构
```

**对比 Claude Code**：
- Claude Code: 在查询边界（发送给 LLM 前）通过 `enforceToolResultBudget` 处理
- 当前系统: 在 observation 格式化阶段处理
- **差异**：时机不同，但效果相同，都能防止大结果溢出上下文

**参考文件**：
- `agents/context/observation_policy.py` - 决策系统
- `agents/artifacts/artifact_store.py` - 持久化层
- `agents/context/observation_formatters/large_payload.py` - 格式化器

**结论**：✅ 已完成，无需额外实现

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

| 优先级 | 差距项 | 影响范围 | 实现成本 | 状态 |
|--------|--------|----------|----------|------|
| ⚠️ 高（按需） | Hooks 系统 | 扩展能力 | 中 | 待实现 |
| ✅ 已完成 | 大结果落盘闭环 | 上下文管理 | - | 已完成 |
| 🔧 低（体验） | 可观测语义统一 | 用户体验 | 低 | 可选 |
| 🔧 低（安全） | MCP 细粒度权限 | 安全控制 | 低 | 可选 |
| 🔧 低（性能） | Exposure 缓存 | 性能优化 | 低 | 可选 |
| 🔧 低（扩展） | PermissionDecision 扩展 | 可扩展性 | 低 | 可选 |
| 📝 低（文档） | 流程可视化 | 文档质量 | 低 | 可选 |
| 🧪 低（测试） | 集成测试覆盖 | 测试质量 | 中 | 可选 |

### 核心结论

1. **架构层面**：核心架构已基本对齐 Claude Code（~85%），当前剩余重点是 Hooks 与可观测语义统一
2. **大结果落盘**：✅ 已完成，通过 ObservationPolicy + ArtifactStore 实现
3. **体验层面**：可观测语义和 MCP 权限是体验优化项，不影响核心功能
4. **性能层面**：当前性能已足够，缓存优化是锦上添花
5. **文档测试**：文档已较完善，可视化和集成测试是增强项

### 实施建议

- **短期**：保持当前架构，专注业务功能
- **中期**：按需实现 Hooks（如果需要自定义工具执行行为）
- **长期**：逐步完善体验优化和测试覆盖

---

**最后更新**：2026-04-01

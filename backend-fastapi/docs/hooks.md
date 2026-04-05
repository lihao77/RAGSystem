# Hook 系统文档

## 当前状态

当前实现已打通 Tool Runtime 与 Approval 生命周期的主链 Hook 闭环，并把关键事件语义从“文档约定 + phase filter”进一步收紧为“结果类型协议 + runtime defensive clamp”的双约束；但整体仍保持 Phase 1 范围，尚未扩展到更多 backend 与子域 Hook。

### 已实现

- Tool Runtime 事件接入：`tool.before_permission`、`tool.after_permission`、`tool.before_execute`、`tool.after_execute`、`tool.on_error`
- Approval 事件接入：`approval.required`、`approval.resolved`、`approval.denied`、`approval.error`
- Hook 子系统基础设施：`models / registry / config_loader / matcher / executor / broadcast / bootstrap`
- Backend 类型：`function`、`prompt`、`callback`
- 结果协议已按事件族收紧：`DecisionHookResult`、`ContextHookResult`、`ObservationHookResult`、`ErrorHookResult`、`ApprovalHookResult`
- Approval hook 结果已进入审批主链：
  - `approval.required` 会把 hook 数据并入 `user.approval_required.data["approval_hook"]`
  - `approval.resolved / denied / error` 会把 hook 数据并入 `metadata["approval"]`
- `before_execute.additional_context` 已落入 `ToolExecutionResult.metadata["hook_additional_context"]`，并在 observation 物化阶段以 `[Hook Context]` 前缀块进入模型主链
- `after_execute.additional_context` 当前仍只保留在 metadata，不进入 observation 主链
- `workspace_trust` 已从系统配置 `CONFIG_ROOT/app/config.yaml` 中的 `hooks.workspace_trust` 真实解析，并在 runtime / approval 两条主链统一注入 `HookContext.workspace_trust`
  - 路径规则按“路径边界匹配”而不是纯字符串前缀匹配，避免 `E:/Python/RAGSystem2` 误命中 `E:/Python/RAGSystem`
  - trust resolver 每次按当前配置重新加载，避免模块级单例缓存导致配置陈旧
- Hook 生命周期广播已覆盖：`hook.started`、`hook.progress`、`hook.response`、`hook.error`

### 部分实现

- `fail_mode: closed_for_decision_open_for_observation` 已做基础语义映射；当前又增加了“事件 -> 结果类型”校验，非法结果在 fail-open hook 下回退为空结果，在 fail-closed hook 下按原 fail 语义阻断
- `workspace_trust` 当前先收紧为二值：`trusted` / `untrusted`；规则集也只支持 `workspace_root_prefix` + `default`
- `hook.progress` 当前支持的是“hook 返回 progress 字段后发出一次 progress 事件”；它仍不是执行过程中的流式增量协议

### 未实现 / 计划中

- 真正把 `additional_context` 注入到 AI prompt / observation 上下文链路，而不仅是 metadata 可见化
- 更严格的 per-event 输入/输出协议
- 非 `function/prompt/callback` 的 backend（如 http / agent）
- Agent lifecycle hooks、bash/memory/skill/artifact 子域 hooks

## 概述

RAGSystem 的 Hook 系统提供了事件驱动的扩展机制，允许在工具执行、审批流程等关键点注入自定义逻辑。

## 设计原则

1. **观察优先**：Phase 1 专注于观察和决策，不支持业务参数变异
2. **最小侵入**：Hook 作为旁路决策层，不破坏现有 runtime 收敛
3. **安全边界**：严格的权限控制和超时机制
4. **统一广播**：所有 Hook 事件通过现有 EventBus 发布

## 架构

### 核心组件

```
hooks/
├── models.py           # 数据模型（HookContext, HookResult, HookDefinition）
├── registry.py         # Hook 注册表
├── config_loader.py    # 配置加载器
├── matcher.py          # Hook 匹配器
├── executor.py         # Hook 执行器
├── broadcast.py        # 事件广播
├── bootstrap.py        # 启动引导
└── builtin/           # 内建 Hook handlers
    ├── __init__.py
    └── tool_hooks.py
```

### 执行流程

```
1. 事件触发（如 tool.before_execute）
2. 从 Registry 获取候选 Hooks
3. Matcher 过滤（结构化字段 + if 表达式）
4. 按优先级排序
5. 依次执行 Hook handlers
6. 合并 HookResult
7. 广播 Hook 生命周期事件
8. 返回合并结果
```

## 事件类型

### Tool Runtime 事件（Phase 1）

- `tool.before_permission` - 权限评估前
- `tool.after_permission` - 权限评估后
- `tool.before_execute` - 工具执行前
- `tool.after_execute` - 工具执行后
- `tool.on_error` - 工具执行异常

### Approval 事件（Phase 1）

- `approval.required` - 审批请求发布
- `approval.resolved` - 审批通过
- `approval.denied` - 审批拒绝
- `approval.error` - 审批异常

### Hook 广播事件（Phase 1）

- `hook.started` - Hook 开始执行
- `hook.progress` - Hook 执行进度（可选）
- `hook.response` - Hook 执行完成
- `hook.error` - Hook 执行失败

## Hook 定义

### 系统配置格式

Hook 不再使用独立 `hooks.yaml`；系统级 Hook 配置收敛到 `CONFIG_ROOT/app/config.yaml` 的 `hooks` 字段。

```yaml
hooks:
  enabled: true
  workspace_trust:
    default: trusted
    rules:
      - workspace_root_prefix: "E:/Python/RAGSystem"
        trust: trusted
```

默认 HookDefinition 由代码内建，`config.yaml` 只负责少量系统级配置（如启用状态与 `workspace_trust`）。

### Matcher 字段

结构化匹配字段：
- `tool_names` - 工具名称列表
- `agent_names` - Agent 名称列表
- `callers` - 调用者类型（direct/skill/agent）
- `risk_levels` - 风险等级（low/medium/high/critical）
  - 当前优先从 `HookContext.metadata.risk_level` 读取
  - fallback 到 `permission_decision.risk_level`
- `workspace_trust` - 工作区信任级别
- `session_ids` - 会话 ID 列表
- `user_roles` - 用户角色列表
- `when_result_success` - 结果成功状态过滤
- `when_permission_mode` - 权限模式过滤
  - 当前优先从 `HookContext.metadata.permission_mode` 读取
  - fallback 到 `permission_decision.permission_mode`
- `sources` - 来源过滤
- `tags` - 标签过滤

If 表达式（二次过滤）：
```yaml
if: "context.current_agent_name != 'chart_agent'"
```

允许的表达式字段：
- `context.event_name`
- `context.phase`
- `context.session_id`
- `context.agent_name`
- `context.tool_name`
- `context.caller`
- `context.workspace_trust`
- `context.metadata`

### Backend 类型

#### Function Backend

执行 Python 函数：

```yaml
backend:
  type: function
  target: "module.path:function_name"
  config:
    custom_param: value
```

Handler 签名：
```python
def handler(context: HookContext, config: dict) -> HookResult:
    # 处理逻辑
    return HookResult(...)
```

#### Prompt Backend

返回附加上下文：

```yaml
backend:
  type: prompt
  target: "prompt_template"
  config:
    prompt: "Additional context for {tool_name}"
```

#### Callback Backend

仅观察，不影响执行：

```yaml
backend:
  type: callback
  target: "noop"
```

## Hook Result 协议

### 公共控制字段

- `continue_execution: bool` - 是否继续执行（默认 True）
- `block_execution: bool` - 是否阻止执行（默认 False）
- `block_reason: str` - 阻止原因

### 事件族结果类型

- `DecisionHookResult`
  - 用于：`tool.before_permission`、`tool.after_permission`
  - 允许字段：`permission_decision`、`ui_message`、`ui_metadata`、`tags`、`metadata`、`broadcast_progress`
- `ContextHookResult`
  - 用于：`tool.before_execute`
  - 允许字段：`additional_context`、`ui_message`、`ui_metadata`、`tags`、`metadata`、`broadcast_progress`
- `ObservationHookResult`
  - 用于：`tool.after_execute`
  - 允许字段：`additional_context`、`ui_message`、`ui_metadata`、`tags`、`metadata`、`broadcast_progress`
- `ErrorHookResult`
  - 用于：`tool.on_error`
  - 允许字段：`tags`、`metadata`、`broadcast_progress`
- `ApprovalHookResult`
  - 用于：`approval.required`、`approval.resolved`、`approval.denied`、`approval.error`
  - 允许字段：`ui_message`、`ui_metadata`、`tags`、`metadata`
  - 明确禁止：`permission_decision`、`additional_context`、`block_execution` 之外的审批决策语义扩展

### additional_context 注入语义

- `tool.before_execute.additional_context`
  - 会被合并去重
  - 先落到 `ToolExecutionResult.metadata["hook_additional_context"]`
  - 随后在 observation 物化阶段被消费，并以前缀块形式进入下一轮模型可见的 tool observation
- `tool.after_execute.additional_context`
  - 当前仍只保留在 metadata，不进入模型主链

### Matcher 表达式

- `if_expr` 当前使用 AST 白名单求值器，不再使用 `eval`
- 支持操作：`==`、`!=`、`in`、`not in`、`and`、`or`、`not`
- 支持字面量：字符串、布尔值、`None`、list、tuple、dict
- 支持访问：`context.xxx`、`context.metadata.xxx`、`context.metadata.get(...)`
- 非法字段访问、非法调用或不支持的 AST 节点会 fail-safe 返回 `False`

## Event Semantics

| 事件 | 可读上下文 | 当前允许消费字段 | 当前忽略/未接入字段 |
|---|---|---|---|
| `tool.before_permission` | tool/input/caller/risk | `block_execution`, `permission_decision`, `ui_message`, `ui_metadata`, `tags`, `metadata` | `additional_context`, result/error 相关字段 |
| `tool.after_permission` | permission decision / mode / risk | `block_execution`, `permission_decision`, `ui_message`, `ui_metadata`, `tags`, `metadata` | `additional_context` |
| `tool.before_execute` | input / permission / risk | `block_execution`, `ui_message`, `ui_metadata`, `tags`, `metadata`, `additional_context`（会进入 observation 主链） | result/error 相关字段 |
| `tool.after_execute` | result_snapshot | `ui_message`, `ui_metadata`, `tags`, `metadata`, `additional_context`（当前仅保留 metadata） | `permission_decision` |
| `tool.on_error` | error_snapshot | `tags`, `metadata` | `permission_decision`, `additional_context` |
| `approval.required` | approval reason / risk / permission mode | `ui_message`, `ui_metadata`, `tags`, `metadata`；并进入 `user.approval_required.data["approval_hook"]` | tool result 相关字段 |
| `approval.resolved` | approval reason / risk / permission mode / note | `ui_message`, `ui_metadata`, `tags`, `metadata`；并进入成功结果 `metadata["approval"]` | `permission_decision` |
| `approval.denied` | approval reason / risk / permission mode | `ui_message`, `ui_metadata`, `tags`, `metadata`；并进入 error result `metadata["approval"]` | `permission_decision` |
| `approval.error` | approval reason / risk / permission mode / error | `ui_message`, `ui_metadata`, `tags`, `metadata`；并进入 error result `metadata["approval"]` | `permission_decision`, `additional_context` |

> 当前主链不再只依赖统一宽 `HookResult` + 文档约定；runtime 会按事件族校验结果类型，并在消费侧继续做 defensive clamp。
>
> runtime 侧的 `tool.before_permission / after_permission / before_execute / after_execute / on_error` 与 approval 侧的 `approval.required / resolved / denied / error` 都已形成真实消费闭环。

## 内建 Hooks

### tool-risk-audit

审计高风险工具执行：

```yaml
id: tool-risk-audit
events:
  - tool.before_permission
  - tool.after_execute
matcher:
  tool_names:
    - execute_bash
    - write_memory
    - edit_file
    - write_file
  callers:
    - direct
```

功能：
- 记录工具执行详情
- 生成审计日志
- 不影响执行流程

对于 `write_memory`，Hook 读取的是 runtime 注入后的实际 handler 入参快照；因此当 `scope=session` 时，会看到自动补全的 `session_id`，而不是仅看到模型原始提交的参数。

同理，其他 memory 工具（`list_memory_index`、`read_memory_entry`、`archive_memory`）在 session scope 下也遵循相同规则：Hook 与工具实现读取的都是 runtime 注入后的实际参数视图。

### approval-ui-enhancement

增强审批 UI：

```yaml
id: approval-ui-enhancement
events:
  - approval.required
matcher:
  risk_levels:
    - high
    - critical
```

功能：
- 添加工具特定警告
- 增强审批提示文案
- 提供风险分类信息

### bash-command-validation

验证 Bash 命令：

```yaml
id: bash-command-validation
events:
  - tool.before_execute
matcher:
  tool_names:
    - execute_bash
fail_open: false
```

功能：
- 检测危险命令模式
- 阻止潜在破坏性操作
- Untrusted workspace 强制审批

### memory-write-guard

守护记忆写入：

```yaml
id: memory-write-guard
events:
  - tool.before_execute
matcher:
  tool_names:
    - write_memory
```

功能：
- 添加记忆写入上下文
- 提醒持久化影响

## Agent 级配置覆盖

在 `agents/configs/agent_configs.yaml` 中：

```yaml
agents:
  chart_agent:
    hooks:
      disable_ids:
        - tool-risk-audit
      enable_ids:
        - custom-hook
      priority_overrides:
        memory-write-guard: 220
```

限制：
- 只能开关已有 Hook
- 只能调整优先级
- 不能替换 backend.target
- 不能添加新 Hook

## 安全约束

### Phase 1 限制

1. **只读上下文**：HookContext 是 frozen dataclass
2. **无参数变异**：不允许修改工具 arguments
3. **无结果变异**：不允许修改工具原始输出
4. **本地 Handler**：只支持 Python function backend
5. **超时保护**：默认 1 秒超时
6. **Fail 模式**：观察型 fail-open，决策型 fail-closed

### Workspace Trust

- Trusted workspace：所有 Hook 正常执行
- Untrusted workspace：
  - 某些 Hook 自动升级为 ask
  - 未来的 http/agent backend 被禁用

### 权限合并规则

```
基础权限（tools.permissions）
    ↓
Hook 权限覆盖（只能收窄）
    ↓
最终决策
```

Hook 不能：
- 把 deny 放宽成 allow
- 绕过基础权限检查

Hook 可以：
- 把 allow 收窄成 ask
- 把 allow 收窄成 deny
- 把 ask 收窄成 deny

## 使用示例

### 创建自定义 Hook Handler

```python
# hooks/builtin/custom_hooks.py

from hooks.models import HookContext, HookResult

def my_custom_handler(context: HookContext, config: dict) -> HookResult:
    """自定义 Hook handler."""

    # 检查条件
    if context.tool_name == "sensitive_tool":
        # 阻止执行
        return HookResult(
            block_execution=True,
            block_reason="Sensitive tool blocked by policy",
        )

    # 添加上下文
    return HookResult(
        additional_context=[
            f"Tool {context.tool_name} called by {context.agent_name}",
        ],
        tags=["custom_audit"],
    )
```

### 注册 Hook

系统级 HookDefinition 已内建在代码中；若需要调整系统级行为，请在 `CONFIG_ROOT/app/config.yaml` 的 `hooks` 字段中配置启用状态或 `workspace_trust`。

如果需要新增一个真正的系统级 HookDefinition，应修改 Hook 默认定义代码，而不是再新增独立 `hooks.yaml`。

### 异步 Handler

```python
async def async_handler(context: HookContext, config: dict) -> HookResult:
    """异步 Hook handler."""

    # 可以调用异步 API
    result = await some_async_check(context.tool_name)

    if not result.allowed:
        return HookResult(
            permission_decision="deny",
            block_reason=result.reason,
        )

    return HookResult()
```

## 调试

### 日志

Hook 执行日志：

```
INFO: Executing 2 hooks for event tool.before_execute
DEBUG: Hook tool-risk-audit matched for event tool.before_execute
INFO: [AUDIT] High-risk tool execution: {...}
DEBUG: Broadcasted hook event: hook.started for hook tool-risk-audit
```

### 事件追踪

Hook 事件通过 EventBus 广播，可在前端查看：

```json
{
  "type": "hook.response",
  "data": {
    "hook_id": "tool-risk-audit",
    "hook_name": "High-Risk Tool Audit",
    "matched_event": "tool.before_execute",
    "backend": "function",
    "decision": "continue",
    "duration_ms": 12.5
  }
}
```

## 性能考虑

### 优化建议

1. **Matcher 优先级**：结构化字段匹配比 if 表达式快
2. **超时设置**：观察型 Hook 可以设置更短超时
3. **广播控制**：高频 Hook 可以禁用 broadcast
4. **优先级排序**：决策型 Hook 优先级高于观察型

### 性能指标

- Hook 匹配：< 1ms
- Function backend 执行：< 10ms（典型）
- 事件广播：< 5ms
- 总开销：< 20ms（单个 Hook）

## 未来扩展（Phase 2+）

### Agent Lifecycle Hooks

- `agent.run_start/end/error`
- `agent.round_start/end`
- `agent.intent_generated`
- `agent.call_agent_start/end`

### 子域 Hooks

- Skill: `skill.activate/script.before/after/error`
- Memory: `memory.read/write/archive.before/after`
- Artifact: `artifact.create/revise.before/after`
- Bash: `bash.validate/before/after_execute/on_error`

### 受控变异型 Hooks（Phase 3）

允许有限变异：
- `updated_input`：仅限 UI 层字段
- `updated_output`：仅限展示层字段

明确禁止：
- 任意修改工具 arguments
- 任意修改 MCP 原始输出
- 自动重放/重试

### 高级 Backend（Phase 4）

- HTTP backend：调用外部 API
- Agent backend：委派给子 Agent
- 更严格的安全审查

## 故障排查

### Hook 未执行

1. 检查 Hook 是否启用：`enabled: true`
2. 检查事件名称是否匹配
3. 检查 Matcher 字段是否匹配
4. 检查 if 表达式是否正确
5. 查看日志中的匹配信息

### Hook 执行失败

1. 检查 backend.target 路径是否正确
2. 检查 Handler 签名是否正确
3. 查看 hook.error 事件
4. 检查超时设置
5. 查看 fail_open 配置

### 权限决策不生效

1. 确认 Hook 返回了 `permission_decision`
2. 检查权限合并规则（deny > ask > allow）
3. 确认基础权限允许执行
4. 查看 tool.after_permission 事件

## 参考

- 设计文档：`docs/refactor/HOOK_SYSTEM_DESIGN.md`
- 实施计划：见本文档开头
- Claude Code 对标：`docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`

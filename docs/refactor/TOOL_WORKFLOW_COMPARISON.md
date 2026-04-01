# 工具流程重构前后对比

## 核心差异总览

| 维度 | 重构前 | 重构后 | 影响 |
|------|--------|--------|------|
| **Context 传递** | 14 个散装参数 | 1 个 ToolUseContext 对象 | 参数传递更清晰 |
| **Context 可变性** | 执行中不断 mutate | 只读输入袋 | 避免副作用 |
| **Hooks 系统** | 5 个空函数调用 | 已移除 | 每次工具调用节省 ~10 次函数调用 |
| **权限决策** | 9 字段 PermissionDecision | 3 态决策（allow/deny/ask） | 语义更清晰 |
| **Exposure 查询** | 全量遍历所有工具 | 单工具快速路径 | 避免热路径性能问题 |
| **结果包装** | envelope 反复拆装 | 直接返回 ToolExecutionResult | 事件链路简化 |
| **事件字段** | 10+ 字段（envelope/ref/refs/artifacts） | 5 字段（preview/raw_result/approval） | 前后端数据结构简化 |

---

## 详细对比

### 1. Context 传递方式

#### 重构前：散装参数（14 个）

```python
def execute_tool(
    tool_name, arguments,
    agent_config=None,
    event_bus=None,
    user_role=None,
    caller="direct",
    session_id=None,
    run_id=None,
    cancel_event=None,
    parent_call_id=None,
    current_agent_name=None,
    tool_call_id=None,
    round=None,
    order=None,
    round_index=None,
):
    # 每个函数都要重复传递这些参数
    allowed, error, msg = request_user_approval_if_needed(
        tool_name, arguments,
        agent_config=agent_config,
        event_bus=event_bus,
        user_role=user_role,
        caller=caller,
        session_id=session_id,
    )

    call_arguments = build_handler_call_arguments(
        handler, arguments,
        session_id=session_id,
        run_id=run_id,
        agent_config=agent_config,
        event_bus=event_bus,
        user_role=user_role,
        caller=caller,
        cancel_event=cancel_event,
        parent_call_id=parent_call_id,
        current_agent_name=current_agent_name,
        tool_call_id=tool_call_id,
        round=round,
        order=order,
        round_index=round_index,
    )

    result = execute_mcp_tool(
        tool_name, arguments,
        session_id=session_id,
        run_id=run_id,
    )
```

**问题**：
- 参数列表冗长，容易遗漏
- 每个子函数都要重复声明参数
- 类型不明确（都是 Optional）

#### 重构后：ToolUseContext 对象

```python
def execute_tool(
    tool_name, arguments,
    agent_config=None, event_bus=None, user_role=None,
    caller="direct", session_id=None, run_id=None,
    cancel_event=None, parent_call_id=None,
    current_agent_name=None, tool_call_id=None,
    round=None, order=None, round_index=None,
    request_id=None, agent_display_name=None,
) -> ToolExecutionResult:
    # 一次性构建 context
    context = ToolUseContext(
        tool_name=tool_name,
        arguments=dict(arguments or {}),
        agent_config=agent_config,
        event_bus=event_bus,
        user_role=user_role,
        caller=caller,
        session_id=session_id,
        run_id=run_id,
        request_id=request_id,
        cancel_event=cancel_event,
        parent_call_id=parent_call_id,
        current_agent_name=current_agent_name,
        agent_display_name=agent_display_name or current_agent_name,
        tool_call_id=tool_call_id,
        round=round,
        order=order,
        round_index=round_index,
    )

    # 子函数只需传递 context
    allowed, error, msg = request_user_approval_if_needed(context)
    call_arguments = build_handler_call_arguments(handler, context)
    result = execute_mcp_tool(context)
```

**优势**：
- 参数传递清晰，一次构建到处使用
- 类型明确（dataclass 有字段定义）
- 易于扩展（新增字段不影响函数签名）

---

### 2. Context 可变性

#### 重构前：Mutable Accumulator

```python
@dataclass
class ToolUseContext:
    tool_name: str
    arguments: Dict[str, Any]
    # ... 输入参数 ...

    # 执行过程中被 mutate 的字段：
    approval_state: str = "not_required"        # ← approvals.py 修改
    approval_message: str = ""                  # ← approvals.py 修改
    timeout_seconds: int = 60                   # ← executor.py 修改
    handler_kind: str = "local"                 # ← executor.py 修改
    handler_name: Optional[str] = None          # ← executor.py 修改
    metadata: Dict[str, Any] = field(default_factory=dict)  # ← 到处 update
    exposure_decision: Optional[...] = None     # ← permissions.py 修改
    permission_decision: Optional[...] = None   # ← approvals.py 修改

# 执行过程：
context = ToolUseContext(...)
request_user_approval_if_needed(context)
# ↑ 内部修改 context.approval_state / context.permission_decision / context.metadata

context.timeout_seconds = timeout  # ← executor.py 修改
context.handler_kind = 'local'     # ← executor.py 修改
context.metadata.update(hook_result.metadata_patch)  # ← 到处 update
```

**问题**：
- Context 既是输入又是输出，职责不清
- 多处 mutate，难以追踪状态变化
- 并发场景下有隐患（虽然当前是单线程）

#### 重构后：Immutable Input Bag

```python
@dataclass
class ToolUseContext:
    """工具调用的输入上下文袋（immutable-style）。"""
    tool_name: str
    arguments: Dict[str, Any]
    agent_config: Any = None
    event_bus: Any = None
    user_role: Optional[str] = None
    caller: str = "direct"
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    request_id: Optional[str] = None
    cancel_event: Any = None
    parent_call_id: Optional[str] = None
    current_agent_name: Optional[str] = None
    agent_display_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    round: Optional[int] = None
    order: Optional[int] = None
    round_index: Optional[int] = None
    # 没有 approval_state / metadata / handler_kind 等可变字段

# 执行过程：
context = ToolUseContext(...)  # 构建后不再修改
allowed, error, approval_message = request_user_approval_if_needed(context)
# ↑ 通过返回值传递状态，不修改 context

result.metadata["approval_message"] = approval_message  # ← 状态写入 result
```

**优势**：
- Context 职责单一：只读输入袋
- 状态通过返回值传递，数据流清晰
- 无副作用，易于测试和推理

---

### 3. Hooks 系统

#### 重构前：空函数骨架（死代码）

```python
def _run_hooks(context, phase, current_result=None, current_error=None) -> HookResult:
    metadata_patch = {'hook_phase': phase}
    if phase == 'before_execute' and isinstance(context.arguments, dict):
        return HookResult(continue_execution=True, mutated_arguments=dict(context.arguments), metadata_patch=metadata_patch)
    if phase == 'after_execute':
        return HookResult(continue_execution=True, override_result=current_result, metadata_patch=metadata_patch)
    if phase == 'on_error' and current_error is not None:
        metadata_patch['error_type'] = type(current_error).__name__
        return HookResult(continue_execution=True, metadata_patch=metadata_patch)
    return HookResult(continue_execution=True, metadata_patch=metadata_patch)

def execute_tool(...):
    try:
        before_permission_hook = _run_hooks(context, 'before_permission')
        context.metadata.update(before_permission_hook.metadata_patch)  # ← 白跑

        allowed, error, msg = request_user_approval_if_needed(context)

        after_permission_hook = _run_hooks(context, 'after_permission')
        context.metadata.update(after_permission_hook.metadata_patch)  # ← 白跑

        before_execute_hook = _run_hooks(context, 'before_execute')
        if before_execute_hook.mutated_arguments is not None:
            context.arguments = before_execute_hook.mutated_arguments  # ← 永远是原值
        context.metadata.update(before_execute_hook.metadata_patch)  # ← 白跑

        # ... 执行工具 ...

        after_execute_hook = _run_hooks(context, 'after_execute', current_result=result)
        context.metadata.update(after_execute_hook.metadata_patch)  # ← 白跑

        return result
    except Exception as error:
        on_error_hook = _run_hooks(context, 'on_error', current_error=error)
        context.metadata.update(on_error_hook.metadata_patch)  # ← 白跑
```

**问题**：
- 每次工具调用白跑 5 次函数调用 + 5 次 dict merge
- `mutated_arguments` / `override_result` 等分支永远不会触发
- 没有 hook registry，无法注册真实 hook
- 增加复杂度但无任何功能

#### 重构后：已移除

```python
def execute_tool(...):
    try:
        allowed, error, msg = request_user_approval_if_needed(context)
        if not allowed:
            return error

        # 直接执行，无 hooks
        if handler is not None:
            call_arguments = build_handler_call_arguments(handler, context)
            result = _run_with_timeout(lambda: handler(**call_arguments), timeout, tool_name)
        elif _TOOL_REGISTRY.is_mcp_tool(tool_name):
            result = execute_mcp_tool(context)
        else:
            result = error_result(f"未知的工具: {tool_name}", tool_name=tool_name)

        result = _normalize_tool_result(result, tool_name)
        if approval_message and result.success:
            result.metadata["approval_message"] = approval_message
        return result
    except Exception as error:
        logger.error(f"执行工具 {tool_name} 失败: {error}")
        return error_result(str(error), tool_name=tool_name)
```

**优势**：
- 主链路简洁，无死代码
- 性能提升（每次工具调用节省 ~10 次函数调用）
- 未来需要时参考 Claude Code 实现真实 hooks

---

### 4. 权限决策结构

#### 重构前：9 字段 PermissionDecision

```python
@dataclass
class PermissionDecision:
    tool_name: str
    visible: bool = False                # ← 内部推导字段
    enabled_for_agent: bool = False      # ← 内部推导字段
    caller_allowed: bool = True          # ← 内部推导字段
    role_allowed: bool = True            # ← 内部推导字段
    execution_allowed: bool = False      # ← 最终决策
    requires_approval: bool = False
    risk_level: str = "low"
    permission_mode: Optional[str] = None
    deny_reason: str = ""
    approval_reason: str = ""
    resolved_from: List[str] = field(default_factory=list)
    caller: Optional[str] = None
    user_role: Optional[str] = None

# 使用：
decision = evaluate_tool_permission(...)
decision.visible = exposure.visible
decision.enabled_for_agent = exposure.visible
decision.caller_allowed = False
decision.execution_allowed = False
decision.deny_reason = "..."
return decision
```

**问题**：
- 内部推导字段（visible / enabled_for_agent / caller_allowed / role_allowed）暴露给调用方
- 字段冗余，语义不清
- 不符合 Claude Code 的三态语义（allow / deny / ask）

#### 重构后：3 态决策

```python
@dataclass
class PermissionDecision:
    """
    三态权限决策，对应 Claude Code 的 allow / deny / ask 语义。

    execution_allowed=True  → allow（继续执行）
    execution_allowed=False → deny（直接拒绝，deny_reason 非空）
    requires_approval=True  → ask（需用户交互审批）
    """
    tool_name: str
    execution_allowed: bool = False      # ← 最终决策
    requires_approval: bool = False      # ← ask 语义
    deny_reason: str = ""                # ← deny 原因
    approval_message: str = ""           # ← 审批通过后的附言
    # 仅用于事件/日志观测，不参与执行决策：
    risk_level: str = "low"
    permission_mode: Optional[str] = None
    resolved_from: List[str] = field(default_factory=list)

# 使用：
decision = evaluate_tool_permission(...)
if not decision.execution_allowed:
    return False, error_result(decision.deny_reason), ""
```

**优势**：
- 语义清晰：allow / deny / ask 三态
- 无冗余字段，只保留决策必需信息
- 对齐 Claude Code 的 PermissionResult 结构

---

### 5. Exposure 查询性能

#### 重构前：全量遍历

```python
def get_tool_exposure_decision(tool_name: str, agent_config) -> ToolExposureDecision:
    # 每次调用都全量遍历所有工具
    resolved = resolve_effective_tool_exposure(agent_config)
    # ↑ 遍历 direct / memory / skill / builtin / delegation / MCP 所有工具
    # 如果 agent 配置了 10 个 MCP server 各 20 个工具 = 200+ 工具

    decision = resolved['decisions'].get(tool_name)
    if decision is not None:
        return decision

    # fallback 逻辑...
```

**问题**：
- 在 `execute_tool` 热路径上每次都全量遍历
- 如果 agent 有 200+ 工具，每次工具调用都遍历 200+ 次
- 性能隐患

#### 重构后：单工具快速路径

```python
def get_tool_exposure_decision(tool_name: str, agent_config) -> ToolExposureDecision:
    """单工具快速暴露查询——不走全量 resolve，直接按来源做针对性检查。"""

    # builtin：始终可见
    if tool_name == 'request_user_input':
        return ToolExposureDecision(visible=True, source='builtin', ...)

    # skill system tools：有任意 enabled_skills 时自动注入
    if tool_name in _TOOL_REGISTRY.get_skill_tool_names():
        enabled_skills = _safe_list(getattr(skills_config, 'enabled_skills', []))
        return ToolExposureDecision(visible=bool(enabled_skills), source='skill', ...)

    # memory 派生工具
    if tool_name in _MEMORY_TOOL_NAMES:
        memory_decisions = _memory_exposure_decisions(agent_config)
        return memory_decisions.get(tool_name, ToolExposureDecision(visible=False, ...))

    # agent delegation 工具
    if source == 'agent':
        enabled_agents = _safe_list(getattr(delegation_config, 'enabled_agents', []))
        return ToolExposureDecision(visible=bool(enabled_agents), source='agent', ...)

    # MCP 工具：只检查 server 是否启用
    if is_mcp_tool(tool_name):
        server_name, _ = parse_mcp_tool_name(tool_name)
        enabled_servers = set(_safe_list(getattr(mcp_config, 'enabled_servers', [])))
        return ToolExposureDecision(visible=server_name in enabled_servers, source='mcp', ...)

    # direct 工具：检查 enabled_tools 列表
    direct_enabled = set(_safe_list(getattr(tools_config, 'enabled_tools', [])))
    return ToolExposureDecision(visible=tool_name in direct_enabled, source='direct', ...)
```

**优势**：
- 按来源优先级检查，找到即返回
- 不遍历所有工具，只检查当前工具
- 全量 `resolve_effective_tool_exposure` 仅在 loader 阶段调用

---

### 6. 结果包装 + 事件链路

#### 重构前：envelope 反复拆装

```python
# executor.py
def _materialize_result_envelope(result, context) -> ToolExecutionResult:
    envelope = build_tool_result_envelope(result, context=context)
    result.metadata.update({
        'result_envelope': envelope,
        'result_preview': envelope.get('preview_text'),
        'result_ref': envelope.get('result_ref'),
        'resource_refs': envelope.get('resource_refs', []),
    })
    return result

def execute_tool(...):
    # ... 执行工具 ...
    result = _materialize_result_envelope(result, context)  # ← 构建 envelope
    return result

# base.py
envelope = result_envelope_payload(result)  # ← 重新构建 envelope
publisher.tool_call_end(
    result_envelope=envelope,
    result_preview=envelope.get('preview_text'),
    result_ref=envelope.get('result_ref'),
    resource_refs=envelope.get('resource_refs'),
    artifacts=envelope.get('artifacts'),
    approval_message=envelope.get('approval_message'),
)

# publisher.py
envelope = self._make_event_value_safe(result_envelope or {})
data = {
    "result_preview": result_preview or envelope.get("preview_text"),
    "result_envelope": envelope,
    "result_ref": envelope.get("result_ref"),
    "resource_refs": envelope.get("resource_refs"),
    "artifacts": envelope.get("artifacts"),
    "approval_message": envelope.get("approval_message"),
}

# step_projector.py
envelope = data.get('result_envelope') or {}
preview = envelope.get('preview_text') or data.get('result')
return {
    'result_envelope': envelope,
    'result_ref': envelope.get('result_ref'),
    'resource_refs': envelope.get('resource_refs'),
    'artifacts': envelope.get('artifacts'),
    'approval_message': envelope.get('approval_message'),
}

# frontend executionProjector.js
result_envelope?.preview_text ?? step.result
result_ref || result_envelope?.result_ref
resource_refs || result_envelope?.resource_refs
artifacts || result_envelope?.artifacts
approval_message || result_envelope?.approval_message
```

**问题**：
- 同一份数据被序列化/反序列化 4+ 次
- 每一层都有 `envelope.get(...)` fallback 链
- envelope 职责不清：既是 executor 输出格式，又是事件传输格式，又是前端消费格式
- 大结果落盘在 executor 里做，不符合 Claude Code 的查询边界模式

#### 重构后：直接返回 ToolExecutionResult

```python
# executor.py
def execute_tool(...):
    # ... 执行工具 ...
    result = _normalize_tool_result(result, tool_name)
    if approval_message and result.success:
        result.metadata["approval_message"] = approval_message
    return result  # ← 直接返回，无 envelope 包装

# base.py
preview_text = result_display_text(result)  # ← 提取预览文本
raw_result = result_event_payload(result)   # ← 提取事件载荷
approval_message = result.metadata.get('approval_message', '')

publisher.tool_call_end(
    result=f"[{tool_name}]\n{observation}",
    result_preview=preview_text,
    raw_result=raw_result,
    raw_result_ref={'session_id': session_id, 'call_id': tool_call_id, 'tool_name': tool_name},
    approval_message=approval_message,
)

# publisher.py
data = {
    "result": self._make_event_value_safe(result),
    "result_preview": result_preview or self._make_event_value_safe(result),
    "raw_result": self._make_event_value_safe(raw_result),
    "raw_result_ref": self._make_event_value_safe(raw_result_ref or {}),
    "approval_message": approval_message or "",
}

# step_projector.py
preview = data.get('result_preview') or data.get('result')
return {
    'result': preview,
    'result_preview': preview,
    'raw_result': data.get('raw_result'),
    'raw_result_ref': data.get('raw_result_ref') or {},
    'approval_message': data.get('approval_message') or '',
}

# frontend executionProjector.js
result_preview ?? step.result
raw_result_ref
approval_message
```

**优势**：
- 数据流清晰：executor → result → event → frontend
- 无反复拆装，每层只提取需要的字段
- 事件结构简化：从 10+ 字段减少到 5 字段
- 大结果落盘逻辑已移除（未来在查询边界实现）

---

### 7. 事件数据结构

#### 重构前

```json
{
  "type": "call.tool.end",
  "tool_name": "read_file",
  "success": true,
  "result": "[read_file]\n...",
  "result_preview": "...",
  "raw_result": {...},
  "raw_result_ref": {...},
  "raw_result_available": true,
  "result_envelope": {
    "success": true,
    "tool_name": "read_file",
    "preview_text": "...",
    "inline_payload": {...},
    "materialized": false,
    "result_ref": {...},
    "resource_refs": [...],
    "artifacts": [...],
    "approval_message": "...",
    "execution_info": {...}
  },
  "result_ref": {...},
  "resource_refs": [...],
  "artifacts": [...],
  "approval_message": "..."
}
```

**问题**：
- 字段冗余（result_ref 出现 3 次）
- envelope 内外字段重复
- 前端需要多层 fallback（`envelope?.result_ref || result_ref`）

#### 重构后

```json
{
  "type": "call.tool.end",
  "tool_name": "read_file",
  "success": true,
  "result": "[read_file]\n...",
  "result_preview": "...",
  "raw_result": {...},
  "raw_result_ref": {"session_id": "...", "call_id": "...", "tool_name": "..."},
  "raw_result_available": true,
  "approval_message": "...",
  "elapsed_time": 0.123
}
```

**优势**：
- 字段精简，无冗余
- 前端直接消费，无 fallback 链
- 数据结构扁平，易于理解

---

## 性能对比

| 操作 | 重构前 | 重构后 | 提升 |
|------|--------|--------|------|
| **Hooks 调用** | 5 次空函数 + 5 次 dict merge | 0 次 | 节省 ~10 次函数调用 |
| **Exposure 查询** | 全量遍历 200+ 工具 | 单工具快速路径 | 避免 O(n) 遍历 |
| **Envelope 构建** | 4+ 次序列化/反序列化 | 0 次 | 事件链路简化 |
| **参数传递** | 14 个散装参数 | 1 个 context 对象 | 函数调用开销减少 |

---

## 代码量对比

| 文件 | 重构前 | 重构后 | 变化 |
|------|--------|--------|------|
| `executor.py` | 243 行 | 141 行 | -102 行 |
| `models.py` | 91 行 | 62 行 | -29 行 |
| `approvals.py` | 133 行 | 117 行 | -16 行 |
| `result_references.py` | 373 行 | 274 行 | -99 行 |
| **总计** | **840 行** | **594 行** | **-246 行（-29%）** |

---

## 架构对齐度

| 维度 | 重构前 | 重构后 | Claude Code 模式 |
|------|--------|--------|------------------|
| **Context 模式** | Mutable accumulator | Immutable input bag | ✅ 对齐 |
| **Hooks 系统** | 空函数骨架 | 已移除 | ✅ 对齐（未来需要时再加真实 registry） |
| **权限决策** | 9 字段 | 3 态决策 | ✅ 对齐（allow/deny/ask） |
| **Exposure 查询** | 全量遍历 | 快速路径 | ✅ 对齐（单工具查询） |
| **大结果落盘** | executor 里落盘 | 已移除 | ✅ 对齐（未来在查询边界做） |
| **事件结构** | envelope 反复拆装 | 扁平结构 | ✅ 对齐（直接传递 result） |

---

## 向后兼容性

### 破坏性变更

1. **事件结构变化**：移除 `result_envelope` / `result_ref` / `resource_refs` / `artifacts` 字段
   - **影响**：前端需同步修改（已完成）
   - **迁移**：前端改用 `result_preview` / `raw_result` / `approval_message`

2. **PermissionDecision 字段变化**：移除 `visible` / `enabled_for_agent` / `caller_allowed` / `role_allowed`
   - **影响**：测试需同步修改（已完成）
   - **迁移**：只检查 `execution_allowed` / `deny_reason`

### 兼容性保留

1. **execute_tool 函数签名**：参数列表未变，只是内部改用 context
2. **ToolExecutionResult 结构**：未变，仍然是 `success` / `content` / `metadata` / `artifacts`
3. **权限检查接口**：`check_tool_permission` 保留，内部调用 `evaluate_tool_permission`

---

## 总结

重构的核心目标是**对齐 Claude Code 架构，消除不必要的复杂度**：

✅ **Context 改为只读输入袋**——避免副作用，数据流清晰
✅ **移除 hooks 死代码**——性能提升，主链路简洁
✅ **权限三态决策**——语义清晰，符合 allow/deny/ask 模式
✅ **Exposure 快速路径**——避免热路径性能问题
✅ **移除 envelope 包装**——事件链路简化，前后端数据结构统一
✅ **代码量减少 29%**——移除 246 行死代码和冗余逻辑

重构后的工具流程更加清晰、高效、易于维护，为未来扩展（真实 hooks、大结果落盘、工具并发）打下了坚实基础。

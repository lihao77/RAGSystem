# 工具执行完整流程（重构后）

## 概览

```
Agent.execute()
  → BaseAgent._handle_actions()
    → execute_tool() [runtime/executor.py]
      → ToolUseContext 构建（只读输入袋）
      → request_user_approval_if_needed() [权限 + 审批]
        → evaluate_tool_permission() [三态决策]
        → should_require_approval() [审批策略]
        → 发布 USER_APPROVAL_REQUIRED 事件（如需审批）
      → get_tool_handler() / execute_mcp_tool() [分发]
        → Local handler: build_handler_call_arguments() + _run_with_timeout()
        → MCP tool: mcp_gateway.execute_mcp_tool() → mcp_service.call_tool()
      → _normalize_tool_result() [标准化]
      → 返回 ToolExecutionResult
    → result_display_text() / result_event_payload() [结果提取]
    → publisher.tool_call_end() [事件发布]
      → EventBus → SSE → Frontend
```

---

## 详细流程

### 1. Agent 发起工具调用

**入口**：`agents/core/base.py::BaseAgent._handle_actions()`

```python
# Agent 解析 LLM 返回的 actions
actions = [
    {'tool': 'read_file', 'arguments': {'file_path': 'demo.txt'}},
    {'tool': 'execute_bash', 'arguments': {'command': 'ls -la'}},
]

for idx, action in enumerate(actions):
    tool_name = action['tool']
    arguments = action['arguments']

    # 占位符替换（如果有前序工具结果）
    arguments = self._resolve_tool_references(arguments, tool_results, idx)

    # 检测未替换的占位符
    unresolved = detect_unresolved_placeholders(arguments)
    if unresolved:
        # 返回错误，提示 Agent 检查引用路径
        continue

    # 发布 tool_call_start 事件
    publisher.tool_call_start(call_id, tool_name, arguments, ...)

    # 执行工具
    result = execute_tool(
        tool_name, arguments,
        agent_config=self.agent_config,
        event_bus=event_bus,
        session_id=session_id,
        ...
    )
```

---

### 2. 构建 ToolUseContext（只读输入袋）

**位置**：`tools/runtime/executor.py::execute_tool()`

```python
context = ToolUseContext(
    tool_name=tool_name,
    arguments=dict(arguments or {}),
    agent_config=agent_config,      # Agent 配置（工具暴露、权限）
    event_bus=event_bus,             # 事件总线（审批通知）
    user_role=user_role,             # 用户角色（权限检查）
    caller=caller,                   # 调用来源（direct / code_execution）
    session_id=session_id,           # 会话 ID（审批等待）
    run_id=run_id,                   # 运行 ID（可观测性）
    request_id=request_id,           # 请求 ID（可观测性）
    cancel_event=cancel_event,       # 取消信号
    parent_call_id=parent_call_id,   # 父调用 ID（子 Agent）
    current_agent_name=current_agent_name,
    agent_display_name=agent_display_name,
    tool_call_id=tool_call_id,       # 工具调用 ID
    round=round,                     # ReAct 轮次
    order=order,                     # 工具序号
    round_index=round_index,         # 轮次内索引
)
```

**关键特性**：
- **只读**：context 在执行过程中不被 mutate
- **纯输入**：只承载调用发起时的环境信息
- **无状态累积**：执行过程产生的状态（approval_message、handler_kind）通过返回值传递

---

### 3. 权限检查 + 审批流程

**位置**：`tools/runtime/approvals.py::request_user_approval_if_needed()`

#### 3.1 权限评估（三态决策）

```python
decision = evaluate_tool_permission(
    tool_name=context.tool_name,
    agent_config=context.agent_config,
    user_role=context.user_role,
    caller=context.caller,
)

# decision 结构（精简后）：
# {
#   execution_allowed: bool,      # True=allow, False=deny
#   requires_approval: bool,       # True=ask（需用户交互）
#   deny_reason: str,              # 拒绝原因
#   risk_level: str,               # low/medium/high
#   permission_mode: str,          # standard/strict/...
# }
```

**权限检查链**：
1. **工具是否存在**：`get_tool_permission(tool_name)` → 不存在返回 deny
2. **caller 是否允许**：`caller in permission.allowed_callers` → 不允许返回 deny
3. **工具是否暴露给 Agent**：`get_tool_exposure_decision(tool_name, agent_config)` → 不可见返回 deny
4. **用户角色是否允许**：`user_role in permission.allowed_roles` → 不允许返回 deny
5. **通过所有检查**：返回 allow

**Exposure 快速路径**（避免全量遍历）：
```python
# tools/runtime/exposure.py::get_tool_exposure_decision()
# 按来源优先级检查：
if tool_name == 'request_user_input':  # builtin
    return visible=True
if tool_name in skill_tool_names:      # skill system tools
    return visible=bool(enabled_skills)
if tool_name in memory_tool_names:     # memory 派生工具
    return visible=bool(allowed_scopes)
if source == 'agent':                  # delegation tools
    return visible=bool(enabled_agents)
if is_mcp_tool(tool_name):             # MCP tools
    return visible=(server_name in enabled_servers)
# direct tools
return visible=(tool_name in enabled_tools)
```

#### 3.2 审批策略判断

```python
permission = get_tool_permission(tool_name)
requires, reason = should_require_approval(tool_name, permission, arguments)

# 审批策略（tools/permission_manager.py）：
# - standard 模式：high 风险工具需要审批
# - strict 模式：medium/high 风险工具需要审批
# - permissive 模式：仅 critical 风险工具需要审批
```

#### 3.3 用户审批交互（如需要）

```python
if requires:
    approval_id = str(uuid.uuid4())
    registry.add_pending_approval(session_id, approval_id)

    # 发布审批请求事件
    event_bus.publish(Event(
        type=EventType.USER_APPROVAL_REQUIRED,
        session_id=session_id,
        data={
            "approval_id": approval_id,
            "tool_name": tool_name,
            "arguments": arguments,
            "risk_level": permission.risk_level.value,
            "description": permission.description,
            "permission_mode": permission_mode,
            "approval_reason": reason,
        }
    ))

    # 暂停当前线程，等待用户响应
    pause_current()
    wait_evt.wait()
    resume_current()

    # 获取审批结果
    approved, approval_note = registry.get_approval_result(session_id, approval_id)
    if not approved:
        return False, error_result("用户拒绝执行"), ""

    return True, None, approval_note  # approval_message
```

---

### 4. 工具分发执行

**位置**：`tools/runtime/executor.py::execute_tool()`

#### 4.1 Local Handler（装饰器注册的工具）

```python
handler = get_tool_handler(tool_name)  # 从 TOOL_HANDLERS 查找

if handler is not None:
    # 构建调用参数（从 context 提取 handler 需要的参数）
    call_arguments = build_handler_call_arguments(handler, context)
    # call_arguments = {
    #     **arguments,  # 工具参数
    #     'session_id': context.session_id,  # 如果 handler 签名需要
    #     'agent_config': context.agent_config,
    #     'event_bus': context.event_bus,
    #     ...
    # }

    # 超时执行（execute_code 除外）
    if tool_name == "execute_code":
        result = handler(**call_arguments)
    else:
        result = _run_with_timeout(
            lambda: handler(**call_arguments),
            timeout=permission.timeout_seconds,
            tool_name=tool_name
        )
```

**超时机制**：
- 在线程池中执行，超时返回 `error_result`
- 用户审批等待期间不计入超时（通过 `pause_current()` / `resume_current()`）

#### 4.2 MCP Tool（外部服务工具）

```python
elif _TOOL_REGISTRY.is_mcp_tool(tool_name):
    result = execute_mcp_tool(context)
    # → tools/runtime/mcp_gateway.py::execute_mcp_tool()
    #   → parse_mcp_tool_name("mcp__server__tool") → (server_name, original_tool_name)
    #   → services/mcp_service.py::call_tool(server_name, original_tool_name, arguments)
```

#### 4.3 未知工具

```python
else:
    result = error_result(f"未知的工具: {tool_name}", tool_name=tool_name)
```

---

### 5. 结果标准化

**位置**：`tools/runtime/executor.py::_normalize_tool_result()`

```python
result = _normalize_tool_result(result, tool_name)

# 标准化规则：
# - ToolExecutionResult → 直接返回
# - None → error_result("工具返回了空结果")
# - dict → success_result(content=result)
# - 其他 → success_result(content=str(result))

# 附加审批信息
if approval_message and result.success:
    result.metadata["approval_message"] = approval_message

return result  # ToolExecutionResult
```

---

### 6. 结果提取 + 事件发布

**位置**：`agents/core/base.py::BaseAgent._handle_actions()`

```python
# 提取结果文本（用于 Agent observation）
observation = self._format_tool_observation(result, tool_name, session_id, is_skills_tool)

# 提取结果预览（用于前端显示）
preview_text = result_display_text(result)  # tools/refs/result_references.py
# → 如果失败：返回 error_message
# → 如果成功：返回 primary_content 的文本形式

# 提取事件载荷（用于事件总线）
raw_result = result_event_payload(result)  # tools/refs/result_references.py
# → materialize_result_reference(result) → 转为 dict
# → _clean_value() → 清理 NaN/Inf

# 发布 tool_call_end 事件
publisher.tool_call_end(
    call_id=tool_call_id,
    tool_name=tool_name,
    result=f"[{tool_name}]\n{observation}",
    result_preview=preview_text,
    raw_result=raw_result,
    raw_result_ref={'session_id': session_id, 'call_id': tool_call_id, 'tool_name': tool_name},
    execution_time=elapsed_time,
    success=result.success,
    approval_message=result.metadata.get('approval_message', ''),
    ...
)
```

---

### 7. 事件传播链路

**后端 → 前端**：

```
EventPublisher.tool_call_end()
  → EventBus.publish(Event)
    → SSE Stream (api/routes/chat.py)
      → Frontend EventSource
        → executionProjector.applyStep()
          → state.toolMap.set(call_id, {
              status: 'success',
              result_preview: preview_text,
              raw_result: raw_result,
              approval_message: approval_message,
              ...
            })
```

**事件数据结构**（精简后）：
```json
{
  "type": "call.tool.end",
  "call_id": "tool-uuid",
  "tool_name": "read_file",
  "success": true,
  "result": "[read_file]\n文件内容...",
  "result_preview": "文件内容...",
  "raw_result": {"success": true, "content": "...", "metadata": {}},
  "raw_result_ref": {"session_id": "...", "call_id": "...", "tool_name": "..."},
  "raw_result_available": true,
  "approval_message": "用户批准：允许读取",
  "elapsed_time": 0.123,
  "round": 1
}
```

---

## 关键设计原则（对齐 Claude Code）

### 1. ToolUseContext 是只读输入袋
- ✅ 只在 `execute_tool()` 入口构建一次
- ✅ 执行过程中不 mutate
- ✅ 状态通过返回值传递（approval_message、result）

### 2. 权限是三态决策
- ✅ `execution_allowed=True` → allow（继续执行）
- ✅ `execution_allowed=False` → deny（直接拒绝）
- ✅ `requires_approval=True` → ask（需用户交互）

### 3. Exposure 快速路径
- ✅ 单工具查询，不全量遍历
- ✅ 按来源优先级检查（builtin → skill → memory → agent → MCP → direct）
- ✅ 全量 `resolve_effective_tool_exposure` 仅在 loader 阶段调用

### 4. 结果不做 envelope 包装
- ✅ executor 直接返回 `ToolExecutionResult`
- ✅ 事件链路用 `result_display_text` + `result_event_payload` 提取
- ✅ 大结果预算控制已由 Observation 路径承接：`ObservationPolicy` 决策，`LargePayloadFormatter` 在 observation 格式化阶段落盘

### 5. 无 hooks 骨架
- ✅ 已移除空函数 `_run_hooks`
- ✅ 未来需要时参考 Claude Code 实现真实 shell 命令执行 + registry

---

## 工具注册方式

### 方式一：@tool() 装饰器（推荐）

```python
# tools/tool_executor_modules/skill_tools.py
from tools.decorators import tool
from tools.contracts.permissions import RiskLevel

@tool(
    name="execute_skill_script",
    description="执行 Skill 脚本",
    risk_level=RiskLevel.MEDIUM,
    allowed_callers=["direct"],
    source="skill",  # 标记为 skill 工具
)
def execute_skill_script(skill_name: str, arguments: dict, **kwargs):
    # 实现
    return result
```

**自动发现**：
- 启动时 `tools/auto_discovery.py` 扫描 `tool_executor_modules` 包
- 合并到 `TOOL_HANDLERS` 和 `ToolRegistry`
- 权限自动注册到 `TOOL_PERMISSIONS`

### 方式二：手动注册（已废弃）

```python
# tools/catalog/static_tools.py
STATIC_TOOL_CONTRACTS = {}  # 已清空

# tools/permissions.py
TOOL_PERMISSIONS = {}  # 仅剩文档工具
```

---

## 工具分类

| 类别 | 来源 | 暴露条件 | 示例 |
|------|------|----------|------|
| **Direct** | `tools.enabled_tools` | 显式配置 | `read_file`, `write_file` |
| **Memory** | `memory.allowed_scopes` | Memory 配置派生 | `list_memory_index`, `write_memory` |
| **Skill System** | `skills.enabled_skills` | 有任意 Skill 时自动注入 | `execute_skill_script`, `list_skills` |
| **Builtin** | 硬编码 | 始终可见 | `request_user_input` |
| **Delegation** | `delegation.enabled_agents` | 有子 Agent 时注入 | `call_agent`, `list_child_agents` |
| **MCP** | `mcp.enabled_servers` | MCP Server 启用 | `mcp__filesystem__read_file` |

---

## 可观测性

### 日志

```python
logger.info(f"工具 {tool_name} 审批跳过: {reason} [session_id=xxx run_id=xxx]")
logger.warning(f"工具权限检查失败: {deny_reason} [session_id=xxx]")
logger.error(f"执行工具 {tool_name} 失败: {error} [session_id=xxx]")
```

### 事件

```python
EventType.CALL_TOOL_START   # 工具开始
EventType.CALL_TOOL_END     # 工具结束
EventType.USER_APPROVAL_REQUIRED  # 需要审批
```

### Metadata

```python
result.metadata = {
    'approval_message': '用户批准：允许执行',
    'elapsed_time': 0.123,
    'handler_kind': 'local',  # 或 'mcp'
    'handler_name': 'read_file',
}
```

---

## 错误处理

### 权限拒绝

```python
return error_result("Tool read_file is not enabled for this agent", tool_name=tool_name)
```

### 审批拒绝

```python
return error_result("工具 execute_bash 执行已被拒绝：用户拒绝执行此操作", tool_name=tool_name)
```

### 超时

```python
return error_result("工具 execute_bash 执行超时（60秒）", tool_name=tool_name)
```

### 未知工具

```python
return error_result("未知的工具: unknown_tool", tool_name=tool_name)
```

### 异常捕获

```python
try:
    result = execute_tool(...)
except Exception as error:
    logger.error(f"执行工具 {tool_name} 失败: {error}")
    return error_result(str(error), tool_name=tool_name)
```

---

## 性能优化点

1. **Exposure 快速路径**：单工具查询，不全量遍历（避免每次工具调用遍历 200+ 工具）
2. **移除 hooks 空调用**：每次工具调用节省 5 次函数调用 + 5 次 dict merge
3. **移除 envelope 构建**：事件链路不再反复拆装 envelope
4. **超时机制**：用户等待期间不计入超时（通过 pause/resume）
5. **线程池复用**：`_run_with_timeout` 使用 `ThreadPoolExecutor(max_workers=1)`

---

## 未来扩展点

1. **Hooks 系统**：参考 Claude Code 实现真实的 shell 命令执行 + registry
2. **Exposure 缓存**：在 agent_config 级别做 LRU 缓存（注意 MCP 工具动态性）
3. **工具并发执行**：参考 Claude Code 的 `isConcurrencySafe` 机制
4. **工具结果预算增强**：如需进一步贴近 Claude Code，可补查询边界层的统一 budget/enforcement

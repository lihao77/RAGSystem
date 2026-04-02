# Hook 系统验证指南

## 快速验证

### 方法 1：运行验证脚本（推荐）

```bash
cd backend-fastapi
python hooks/verify_hooks.py
```

这个脚本会自动验证：
1. ✅ 模块导入
2. ✅ 配置加载
3. ✅ Hook 注册表
4. ✅ Hook 执行
5. ✅ 内建 Handlers
6. ✅ 事件类型
7. ✅ 工具运行时集成

**快速模式**（跳过集成测试）：
```bash
python hooks/verify_hooks.py --quick
```

### 方法 2：运行单元测试

```bash
cd backend-fastapi
pytest hooks/tests/test_hooks.py -v
```

### 方法 3：运行集成测试

```bash
cd backend-fastapi
pytest hooks/tests/test_integration.py -v
```

## 详细验证步骤

### 1. 验证配置加载

```python
from hooks.config_loader import load_hooks_config
from pathlib import Path

config_dir = Path("config/yaml")
hooks = load_hooks_config(config_dir)

print(f"加载了 {len(hooks)} 个 Hook")
for hook in hooks:
    print(f"  - {hook.id}: {hook.name}")
```

**预期输出**：
```
加载了 4 个 Hook
  - tool-risk-audit: High-Risk Tool Audit
  - approval-ui-enhancement: Approval UI Enhancement
  - bash-command-validation: Bash Command Validation
  - memory-write-guard: Memory Write Guard
```

### 2. 验证 Hook 注册

```python
from hooks.registry import get_hook_registry
from hooks.bootstrap import bootstrap_hook_system

# Bootstrap hook system
bootstrap_hook_system()

# Get registry
registry = get_hook_registry()

# Check registered hooks
all_hooks = registry.get_all_hooks()
print(f"注册了 {len(all_hooks)} 个 Hook")

# Check hooks for specific event
hooks = registry.get_hooks_for_event("tool.before_execute")
print(f"tool.before_execute 事件有 {len(hooks)} 个 Hook")
```

### 3. 验证 Hook 执行

```python
import asyncio
from hooks.executor import run_hooks
from hooks.models import HookContext
import time

async def test_hook():
    context = HookContext(
        event_name="tool.before_execute",
        phase="before_execute",
        timestamp=time.time(),
        session_id="test-session",
        tool_name="execute_bash",
        agent_name="test_agent",
        caller="direct",
    )

    result = await run_hooks(context)

    print(f"Hook 执行结果:")
    print(f"  - 继续执行: {result.continue_execution}")
    print(f"  - 阻止执行: {result.block_execution}")
    print(f"  - 附加上下文: {len(result.additional_context)} 条")
    print(f"  - 标签: {result.tags}")

    return result

# Run test
asyncio.run(test_hook())
```

### 4. 验证内建 Hook Handlers

```python
from hooks.builtin.tool_hooks import handle_risk_audit
from hooks.models import HookContext
import time

# Test audit handler
context = HookContext(
    event_name="tool.before_execute",
    phase="before_execute",
    timestamp=time.time(),
    tool_name="execute_bash",
    agent_name="test_agent",
)

result = handle_risk_audit(context, {})

print(f"Audit Handler 结果:")
print(f"  - 标签: {result.tags}")
print(f"  - 元数据: {result.metadata}")
```

### 5. 验证事件广播

```python
from agents.events.bus import EventBus, EventType

event_bus = EventBus()
received_events = []

def event_handler(event):
    received_events.append(event)
    print(f"收到事件: {event.type.value}")

# Subscribe to hook events
event_bus.subscribe(
    [EventType.HOOK_STARTED, EventType.HOOK_RESPONSE],
    event_handler
)

# Trigger a hook (through tool execution)
# ... (需要完整的工具执行上下文)

print(f"收到 {len(received_events)} 个 Hook 事件")
```

### 6. 验证工具运行时集成

启动应用并观察日志：

```bash
cd backend-fastapi
python main.py
```

**预期日志输出**：
```
✓ 工具系统 bootstrap 完成
✓ Hook 系统 bootstrap 完成
```

### 7. 端到端测试

通过 API 触发工具执行，观察 Hook 是否生效：

```bash
# 启动后端
cd backend-fastapi
python main.py

# 在另一个终端，创建会话并执行工具
curl -X POST http://localhost:5001/api/agent/sessions \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "orchestrator"}'

# 执行高风险工具（应触发 audit hook）
curl -X POST http://localhost:5001/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "<session_id>",
    "user_input": "请执行 bash 命令：ls -la"
  }'
```

**观察日志中的 Hook 相关输出**：
```
INFO: Executing 1 hooks for event tool.before_execute
DEBUG: Hook tool-risk-audit matched for event tool.before_execute
INFO: [AUDIT] High-risk tool execution: {...}
DEBUG: Broadcasted hook event: hook.started for hook tool-risk-audit
```

## 验证检查清单

### 基础功能
- [ ] 所有 Hook 模块可以正常导入
- [ ] 配置文件可以正常加载
- [ ] 4 个内建 Hook 已注册
- [ ] Hook 注册表工作正常
- [ ] Hook 可以正常执行
- [ ] Hook 结果可以正确合并

### 内建 Hooks
- [ ] tool-risk-audit 可以审计工具执行
- [ ] approval-ui-enhancement 可以增强审批 UI
- [ ] bash-command-validation 可以阻止危险命令
- [ ] memory-write-guard 可以添加记忆写入上下文

### 事件系统
- [ ] Hook 事件类型已注册到 EventBus
- [ ] hook.started 事件可以广播
- [ ] hook.response 事件可以广播
- [ ] hook.error 事件可以广播

### 工具集成
- [ ] tool.before_permission hook 点已集成
- [ ] tool.after_permission hook 点已集成
- [ ] tool.before_execute hook 点已集成
- [ ] tool.after_execute hook 点已集成
- [ ] tool.on_error hook 点已集成
- [ ] approval.required hook 点已集成
- [ ] approval.resolved hook 点已集成

### 高级功能
- [ ] Hook 优先级排序正确
- [ ] Hook Matcher 过滤正确
- [ ] If 表达式求值正确
- [ ] Hook 超时机制工作正常
- [ ] Fail-open/fail-closed 语义正确
- [ ] Agent 级配置覆盖工作正常

## 常见问题排查

### 问题 1：Hook 未执行

**检查**：
1. Hook 是否已启用（`enabled: true`）
2. 事件名称是否匹配
3. Matcher 字段是否匹配
4. If 表达式是否正确

**调试**：
```python
from hooks.matcher import matches_hook

# 检查 Hook 是否匹配
matched = matches_hook(hook, context)
print(f"Hook 匹配: {matched}")
```

### 问题 2：Hook 执行失败

**检查**：
1. Backend target 路径是否正确
2. Handler 函数签名是否正确
3. 查看 hook.error 事件
4. 检查超时设置

**调试**：
```python
# 查看 Hook 执行日志
import logging
logging.basicConfig(level=logging.DEBUG)
```

### 问题 3：权限决策不生效

**检查**：
1. Hook 是否返回了 `permission_decision`
2. 权限合并规则（deny > ask > allow）
3. 基础权限是否允许执行

**调试**：
```python
# 查看权限决策合并过程
result = await run_hooks(context)
print(f"Permission decision: {result.permission_decision}")
```

### 问题 4：事件未广播

**检查**：
1. Hook 配置中 `broadcast: true`
2. EventBus 是否正常工作
3. 订阅者是否正确注册

**调试**：
```python
from agents.events.bus import get_event_bus

event_bus = get_event_bus()
stats = event_bus.get_stats()
print(f"Event bus stats: {stats}")
```

## 性能验证

### 测量 Hook 执行时间

```python
import time
import asyncio
from hooks.executor import run_hooks
from hooks.models import HookContext

async def measure_performance():
    context = HookContext(
        event_name="tool.before_execute",
        phase="before_execute",
        timestamp=time.time(),
        tool_name="execute_bash",
    )

    start = time.time()
    result = await run_hooks(context)
    duration = (time.time() - start) * 1000

    print(f"Hook 执行耗时: {duration:.2f}ms")

    # 应该 < 20ms
    assert duration < 20, f"Hook 执行过慢: {duration}ms"

asyncio.run(measure_performance())
```

## 验证成功标准

Hook 系统验证通过的标准：

1. ✅ 所有单元测试通过
2. ✅ 所有集成测试通过
3. ✅ 验证脚本全部通过
4. ✅ 4 个内建 Hook 正常工作
5. ✅ Hook 事件可以正常广播
6. ✅ 工具执行时 Hook 正常触发
7. ✅ Hook 执行耗时 < 20ms
8. ✅ 应用启动时 Hook 系统正常 bootstrap

如果以上标准全部满足，说明 Hook 系统已正常工作！

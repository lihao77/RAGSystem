# Hook 系统快速开始

## 验证 Hook 系统

### 最简单的方法

```bash
cd backend-fastapi
python hooks/verify_hooks.py
```

如果看到这个输出，说明一切正常：

```
✓ 所有验证通过！Hook 系统工作正常。
```

### 运行测试

```bash
cd backend-fastapi
pytest hooks/tests/test_hooks.py -v
```

预期: 10/10 测试通过

## 使用 Hook 系统

### 1. 查看已有 Hooks

```python
from hooks.registry import get_hook_registry

registry = get_hook_registry()
all_hooks = registry.get_all_hooks()

for hook in all_hooks:
    print(f"{hook.id}: {hook.name}")
```

### 2. 创建自定义 Hook Handler

在 `hooks/builtin/custom_hooks.py` 中：

```python
from hooks.models import HookContext, HookResult

def my_custom_handler(context: HookContext, config: dict) -> HookResult:
    """自定义 Hook handler."""

    # 检查条件
    if context.tool_name == "sensitive_tool":
        return HookResult(
            block_execution=True,
            block_reason="Blocked by custom policy",
        )

    # 添加上下文
    return HookResult(
        additional_context=[
            f"Tool {context.tool_name} called by {context.agent_name}",
        ],
        tags=["custom_audit"],
    )
```

### 3. 注册自定义 Hook

在 `config/yaml/hooks.yaml` 中添加：

```yaml
hooks:
  - id: my-custom-hook
    name: "My Custom Hook"
    description: "Custom hook for sensitive tools"
    enabled: true
    source: system
    priority: 150
    events:
      - tool.before_execute
    matcher:
      tool_names:
        - sensitive_tool
    backend:
      type: function
      target: "hooks.builtin.custom_hooks:my_custom_handler"
```

### 4. 重启应用

```bash
python main.py
```

查看日志确认 Hook 已加载：

```
✓ Hook 系统 bootstrap 完成
```

## 内建 Hooks

系统自带 4 个内建 Hooks：

### 1. tool-risk-audit
审计高风险工具执行

**触发**: execute_bash, write_memory, edit_file, write_file

**作用**: 记录审计日志

### 2. approval-ui-enhancement
增强审批 UI

**触发**: 高风险工具需要审批时

**作用**: 添加工具特定警告信息

### 3. bash-command-validation
验证 Bash 命令

**触发**: execute_bash

**作用**: 阻止危险命令（如 rm -rf /）

### 4. memory-write-guard
守护记忆写入

**触发**: write_memory

**作用**: 添加记忆写入上下文提示

## 调试 Hooks

### 启用详细日志

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

### 查看 Hook 执行

日志中会显示：

```
INFO: Executing 1 hooks for event tool.before_execute
DEBUG: Hook tool-risk-audit matched for event tool.before_execute
INFO: [AUDIT] High-risk tool execution: {...}
```

### 检查 Hook 匹配

```python
from hooks.matcher import matches_hook

matched = matches_hook(hook, context)
print(f"Hook 匹配: {matched}")
```

## 常见问题

### Q: Hook 没有执行？

**检查**:
1. Hook 是否启用 (`enabled: true`)
2. 事件名称是否正确
3. Matcher 是否匹配
4. If 表达式是否正确

### Q: Hook 执行失败？

**检查**:
1. Backend target 路径是否正确
2. Handler 函数签名是否正确
3. 查看 hook.error 事件
4. 检查超时设置

### Q: 权限决策不生效？

**检查**:
1. Hook 是否返回了 `permission_decision`
2. 权限合并规则 (deny > ask > allow)
3. 基础权限是否允许执行

## 更多信息

- 完整文档: `docs/hooks.md`
- 验证指南: `hooks/VERIFICATION_GUIDE.md`
- 实施总结: `hooks/IMPLEMENTATION_SUMMARY.md`
- 验证结果: `hooks/VERIFICATION_RESULTS.md`

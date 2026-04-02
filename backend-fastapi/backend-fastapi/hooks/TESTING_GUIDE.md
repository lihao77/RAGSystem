# Hook 系统实际测试指南

## 已添加的测试 Hooks

我已经在 `config/yaml/hooks.yaml` 中添加了 2 个测试用 Hook：

### 1. test-tool-logger (工具日志记录器)
**作用**: 记录所有工具的执行（before 和 after）

**触发条件**: 所有 direct 调用的工具

**效果**: 在日志中输出类似这样的信息：
```
[TEST HOOK] ▶️ [before_execute] Tool: read_file | Agent: orchestrator | Caller: direct
[TEST HOOK] ✅ [after_execute] Tool: read_file | Agent: orchestrator | Caller: direct | Status: ✅
```

### 2. test-read-file-enhancer (文件读取增强器)
**作用**: 为 read_file 工具添加提示上下文

**触发条件**: read_file 工具执行前

**效果**: 向 AI 添加额外上下文："📖 提示：正在读取文件 read_file，请注意文件内容可能很大"

## 快速测试方法

### 方法 1: 运行测试脚本（推荐）

```bash
cd backend-fastapi
python hooks/test_hooks_live.py
```

这个脚本会模拟各种工具执行场景，你会看到：
- ✅ Hook 日志输出
- ✅ 危险命令被阻止
- ✅ 附加上下文添加
- ✅ Hook 优先级排序

### 方法 2: 启动应用实际测试

```bash
cd backend-fastapi
python main.py
```

**观察启动日志**，应该看到：
```
✓ Hook 系统 bootstrap 完成
```

然后通过 API 执行工具，观察日志中的 Hook 输出。

## 测试场景

### 场景 1: 测试工具日志记录

**操作**: 通过 API 执行任何工具（如 read_file）

**预期日志**:
```
INFO: Executing 2 hooks for event tool.before_execute
INFO: [TEST HOOK] ▶️ [before_execute] Tool: read_file | Agent: orchestrator | Caller: direct
INFO: [TEST HOOK] ✅ [after_execute] Tool: read_file | Agent: orchestrator | Caller: direct | Status: ✅
```

### 场景 2: 测试危险命令阻止

**操作**: 尝试执行危险的 bash 命令

**API 请求**:
```bash
curl -X POST http://localhost:5001/api/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-session",
    "user_input": "执行命令：rm -rf /"
  }'
```

**预期结果**:
- 命令被阻止
- 日志显示: `[TEST HOOK]` 和 `Hook blocked execution`

### 场景 3: 测试文件读取增强

**操作**: 执行 read_file 工具

**预期效果**:
- Hook 添加额外上下文
- AI 收到提示信息

### 场景 4: 测试记忆写入守护

**操作**: 执行 write_memory 工具

**预期效果**:
- Hook 添加记忆写入提示
- 日志显示上下文信息

## 查看 Hook 执行日志

### 启用详细日志

在 `main.py` 或启动时设置日志级别：

```python
import logging
logging.basicConfig(level=logging.INFO)
```

### 关键日志标记

查找这些标记来追踪 Hook 执行：

- `[TEST HOOK]` - 测试 Hook 的输出
- `Executing N hooks for event` - Hook 开始执行
- `Hook X matched for event` - Hook 匹配成功
- `[AUDIT]` - 审计 Hook 的输出
- `Broadcasted hook event` - Hook 事件广播

## 调试 Hook

### 检查 Hook 是否加载

```python
from hooks.registry import get_hook_registry

registry = get_hook_registry()
all_hooks = registry.get_all_hooks()

for hook in all_hooks:
    print(f"{hook.id}: {hook.enabled}")
```

### 检查 Hook 匹配

```python
from hooks.matcher import matches_hook

matched = matches_hook(hook, context)
print(f"Hook 匹配: {matched}")
```

### 查看 Hook 执行结果

Hook 执行后会返回 `HookResult`，包含：
- `continue_execution` - 是否继续执行
- `block_execution` - 是否阻止执行
- `additional_context` - 附加上下文
- `tags` - 标签
- `metadata` - 元数据

## 自定义测试 Hook

### 1. 创建 Handler

在 `hooks/builtin/tool_hooks.py` 中添加：

```python
def my_test_handler(context: HookContext, config: Dict[str, Any]) -> HookResult:
    """我的测试 Hook."""
    logger.info(f"[MY TEST] Tool: {context.tool_name}")

    return HookResult(
        additional_context=["这是我的测试上下文"],
        tags=["my_test"],
    )
```

### 2. 添加配置

在 `config/yaml/hooks.yaml` 中添加：

```yaml
  - id: my-test-hook
    name: "我的测试 Hook"
    description: "测试自定义 Hook"
    enabled: true
    source: system
    priority: 100
    events:
      - tool.before_execute
    matcher:
      tool_names:
        - read_file
    backend:
      type: function
      target: "hooks.builtin.tool_hooks:my_test_handler"
```

### 3. 重启应用

```bash
python main.py
```

## 禁用测试 Hook

如果不想看到测试日志，可以禁用测试 Hook：

在 `config/yaml/hooks.yaml` 中：

```yaml
  - id: test-tool-logger
    enabled: false  # 改为 false
```

或者直接删除测试 Hook 的配置。

## 常见问题

### Q: 看不到 Hook 日志？

**检查**:
1. Hook 是否启用 (`enabled: true`)
2. 日志级别是否为 INFO 或 DEBUG
3. 工具是否匹配 matcher 条件

### Q: Hook 没有执行？

**检查**:
1. 运行 `python hooks/test_hooks_live.py` 验证
2. 查看启动日志是否有 "Hook 系统 bootstrap 完成"
3. 检查 Hook 配置是否正确

### Q: 如何查看所有已加载的 Hooks？

**方法 1**: 运行测试脚本
```bash
python hooks/test_hooks_live.py
```

**方法 2**: 在代码中查询
```python
from hooks.registry import get_hook_registry
registry = get_hook_registry()
print(f"已加载 {len(registry.get_all_hooks())} 个 Hook")
```

## 预期测试结果

运行 `python hooks/test_hooks_live.py` 后，你应该看到：

```
🧪 Hook 系统实际测试
======================================================================

📦 正在加载 Hook 系统...
✅ 成功加载 7 个 Hook

======================================================================
测试 1: 模拟工具执行 - 观察 Hook 日志
======================================================================

▶️  模拟执行 read_file 工具...
INFO: [TEST HOOK] ▶️ [before_execute] Tool: read_file | Agent: orchestrator | Caller: direct

✅ Hook 执行完成
   - 继续执行: True
   - 阻止执行: False
   - 附加上下文: 1 条
     • 📖 提示：正在读取文件 read_file，请注意文件内容可能很大
   - 标签: ['test_logged']

======================================================================
测试 2: Bash 命令校验 - 测试危险命令阻止
======================================================================

▶️  模拟执行危险 bash 命令: rm -rf /

✅ Hook 执行完成
   - 继续执行: False
   - 阻止执行: True
   - 阻止原因: Dangerous command pattern detected: rm -rf /
   - UI 消息: ⛔ Command blocked: Contains dangerous pattern 'rm -rf /'

... (更多测试输出)

✅ 所有测试完成！
```

## 下一步

1. ✅ 运行测试脚本验证 Hook 系统
2. ✅ 启动应用观察实际效果
3. ✅ 通过 API 执行工具测试
4. ✅ 根据需要自定义 Hook

祝测试顺利！🎉

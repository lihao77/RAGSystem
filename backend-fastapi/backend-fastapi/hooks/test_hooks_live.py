#!/usr/bin/env python3
"""
Hook 系统实际测试脚本

模拟工具执行，观察 Hook 的实际效果。
"""

import sys
import asyncio
import time
from pathlib import Path

# Add backend-fastapi to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from hooks.bootstrap import bootstrap_hook_system
from hooks.registry import get_hook_registry
from hooks.models import HookContext
from hooks.executor import run_hooks


async def test_tool_execution_hooks():
    """测试工具执行 Hook."""
    print("\n" + "=" * 70)
    print("测试 1: 模拟工具执行 - 观察 Hook 日志")
    print("=" * 70)

    # 模拟 read_file 工具执行
    print("\n▶️  模拟执行 read_file 工具...")

    context = HookContext(
        event_name="tool.before_execute",
        phase="before_execute",
        timestamp=time.time(),
        session_id="test-session-001",
        run_id="test-run-001",
        agent_name="orchestrator",
        agent_display_name="编排器",
        caller="direct",
        tool_name="read_file",
        tool_call_id="call_001",
        input_snapshot={"file_path": "test.txt"},
    )

    result = await run_hooks(context)

    print(f"\n✅ Hook 执行完成")
    print(f"   - 继续执行: {result.continue_execution}")
    print(f"   - 阻止执行: {result.block_execution}")
    print(f"   - 附加上下文: {len(result.additional_context)} 条")
    if result.additional_context:
        for ctx in result.additional_context:
            print(f"     • {ctx}")
    print(f"   - 标签: {result.tags}")
    print(f"   - 元数据: {result.metadata}")


async def test_bash_validation_hook():
    """测试 Bash 命令校验 Hook."""
    print("\n" + "=" * 70)
    print("测试 2: Bash 命令校验 - 测试危险命令阻止")
    print("=" * 70)

    # 测试危险命令
    print("\n▶️  模拟执行危险 bash 命令: rm -rf /")

    context = HookContext(
        event_name="tool.before_execute",
        phase="before_execute",
        timestamp=time.time(),
        session_id="test-session-002",
        agent_name="orchestrator",
        caller="direct",
        tool_name="execute_bash",
        input_snapshot={"command": "rm -rf /"},
    )

    result = await run_hooks(context)

    print(f"\n✅ Hook 执行完成")
    print(f"   - 继续执行: {result.continue_execution}")
    print(f"   - 阻止执行: {result.block_execution}")
    if result.block_execution:
        print(f"   - 阻止原因: {result.block_reason}")
    if result.ui_message:
        print(f"   - UI 消息: {result.ui_message}")


async def test_memory_write_hook():
    """测试记忆写入 Hook."""
    print("\n" + "=" * 70)
    print("测试 3: 记忆写入守护 - 测试上下文添加")
    print("=" * 70)

    print("\n▶️  模拟执行 write_memory 工具...")

    context = HookContext(
        event_name="tool.before_execute",
        phase="before_execute",
        timestamp=time.time(),
        session_id="test-session-003",
        agent_name="orchestrator",
        caller="direct",
        tool_name="write_memory",
        input_snapshot={
            "type": "user",
            "name": "test_memory",
            "content": "测试记忆内容",
        },
    )

    result = await run_hooks(context)

    print(f"\n✅ Hook 执行完成")
    print(f"   - 附加上下文: {len(result.additional_context)} 条")
    if result.additional_context:
        for ctx in result.additional_context:
            print(f"     • {ctx}")


async def test_after_execute_hook():
    """测试工具执行后 Hook."""
    print("\n" + "=" * 70)
    print("测试 4: 工具执行后 Hook - 测试审计日志")
    print("=" * 70)

    print("\n▶️  模拟工具执行完成...")

    context = HookContext(
        event_name="tool.after_execute",
        phase="after_execute",
        timestamp=time.time(),
        session_id="test-session-004",
        agent_name="orchestrator",
        caller="direct",
        tool_name="write_file",
        result_snapshot={
            "success": True,
            "preview": "文件写入成功",
        },
    )

    result = await run_hooks(context)

    print(f"\n✅ Hook 执行完成")
    print(f"   - 标签: {result.tags}")


async def test_hook_priority():
    """测试 Hook 优先级."""
    print("\n" + "=" * 70)
    print("测试 5: Hook 优先级 - 查看执行顺序")
    print("=" * 70)

    registry = get_hook_registry()

    print("\n📋 已注册的 Hooks (按优先级排序):")
    all_hooks = registry.get_all_hooks()

    # 按优先级排序
    sorted_hooks = sorted(all_hooks, key=lambda h: -h.priority)

    for hook in sorted_hooks:
        status = "✅ 启用" if hook.enabled else "❌ 禁用"
        print(f"   {status} [{hook.priority:3d}] {hook.id}: {hook.name}")
        print(f"        事件: {', '.join(hook.events)}")


async def main():
    """主测试流程."""
    print("\n" + "=" * 70)
    print("🧪 Hook 系统实际测试")
    print("=" * 70)

    # Bootstrap hook system
    print("\n📦 正在加载 Hook 系统...")
    bootstrap_hook_system()

    registry = get_hook_registry()
    all_hooks = registry.get_all_hooks()
    print(f"✅ 成功加载 {len(all_hooks)} 个 Hook")

    # Run tests
    await test_tool_execution_hooks()
    await test_bash_validation_hook()
    await test_memory_write_hook()
    await test_after_execute_hook()
    await test_hook_priority()

    # Summary
    print("\n" + "=" * 70)
    print("✅ 所有测试完成！")
    print("=" * 70)
    print("\n💡 提示:")
    print("   1. 查看上面的日志输出，观察 Hook 的执行效果")
    print("   2. 特别注意 [TEST HOOK] 标记的日志")
    print("   3. 观察危险命令是否被正确阻止")
    print("   4. 查看附加上下文是否正确添加")
    print("\n📝 下一步:")
    print("   - 启动应用: python main.py")
    print("   - 通过 API 执行工具，观察实际效果")
    print("   - 查看日志中的 Hook 执行信息")


if __name__ == "__main__":
    asyncio.run(main())

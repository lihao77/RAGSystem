#!/usr/bin/env python3
"""Hook 系统实际测试脚本"""

import sys
import asyncio
import time
from pathlib import Path

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


async def test_bash_validation_hook():
    """测试 Bash 命令校验 Hook."""
    print("\n" + "=" * 70)
    print("测试 2: Bash 命令校验 - 测试危险命令阻止")
    print("=" * 70)

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


async def main():
    """主测试流程."""
    print("\n" + "=" * 70)
    print("🧪 Hook 系统实际测试")
    print("=" * 70)

    print("\n📦 正在加载 Hook 系统...")
    bootstrap_hook_system()

    registry = get_hook_registry()
    all_hooks = registry.get_all_hooks()
    print(f"✅ 成功加载 {len(all_hooks)} 个 Hook")

    await test_tool_execution_hooks()
    await test_bash_validation_hook()

    print("\n" + "=" * 70)
    print("✅ 所有测试完成！")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())

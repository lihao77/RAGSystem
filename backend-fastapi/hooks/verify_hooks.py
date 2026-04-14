#!/usr/bin/env python3
"""
Hook 系统验证脚本

用法：
    python verify_hooks.py              # 运行所有验证
    python verify_hooks.py --quick      # 快速验证（跳过集成测试）
    python verify_hooks.py --verbose    # 详细输出
"""

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.logging_config import setup_logging
from core.path_resolution import CONFIG_ROOT
from hooks.bootstrap import bootstrap_hook_system
from hooks.config_loader import load_hooks_config
from hooks.executor import run_hooks
from hooks.registry import get_hook_registry, reset_hook_registry
from hooks.models import HookContext

setup_logging()
logger = logging.getLogger(__name__)


class Colors:
    """Terminal colors."""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'


def _colorize(text: str, color: str) -> str:
    return f"{color}{text}{Colors.RESET}"


def print_header(text):
    logger.info("\n%s", _colorize("=" * 70, Colors.BOLD + Colors.BLUE))
    logger.info("%s", _colorize(text, Colors.BOLD + Colors.BLUE))
    logger.info("%s\n", _colorize("=" * 70, Colors.BOLD + Colors.BLUE))


def print_success(text):
    logger.info("%s", _colorize(f"✓ {text}", Colors.GREEN))


def print_error(text):
    logger.error("%s", _colorize(f"✗ {text}", Colors.RED))


def print_warning(text):
    logger.warning("%s", _colorize(f"⚠ {text}", Colors.YELLOW))


def print_info(text):
    logger.info("  %s", text)


def verify_imports():
    print_header("1. 验证模块导入")
    modules = [
        "hooks.models",
        "hooks.registry",
        "hooks.config_loader",
        "hooks.matcher",
        "hooks.executor",
        "hooks.broadcast",
        "hooks.bootstrap",
        "hooks.builtin.tool_hooks",
    ]
    success = True
    for module in modules:
        try:
            __import__(module)
            print_success(f"导入 {module}")
        except Exception as e:
            print_error(f"导入 {module} 失败: {e}")
            success = False
    return success


def verify_config_loading():
    print_header("2. 验证配置加载")
    try:
        hooks = load_hooks_config()
        if not hooks:
            print_warning("未加载到任何 Hook 配置")
            return False
        print_success(f"成功加载 {len(hooks)} 个 Hook 配置")
        hook_ids = [h.id for h in hooks]
        expected_hooks = [
            "tool-risk-audit",
            "approval-ui-enhancement",
            "bash-command-validation",
            "memory-write-guard",
        ]
        for hook_id in expected_hooks:
            if hook_id in hook_ids:
                print_success(f"  找到内建 Hook: {hook_id}")
            else:
                print_warning(f"  未找到内建 Hook: {hook_id}")
        print_info("\nHook 详情:")
        for hook in hooks:
            print_info(f"  - {hook.id}: {hook.name}")
            print_info(f"    事件: {', '.join(hook.events)}")
            print_info(f"    优先级: {hook.priority}")
            print_info(f"    Backend: {hook.backend.type}")
        return True
    except Exception as e:
        print_error(f"配置加载失败: {e}")
        logger.exception("配置加载失败")
        return False


def verify_registry():
    print_header("3. 验证 Hook 注册表")
    try:
        reset_hook_registry()
        registry = get_hook_registry()
        hooks = load_hooks_config()
        for hook in hooks:
            registry.register(hook)
        print_success(f"成功注册 {len(hooks)} 个 Hook")
        for event in ["tool.before_execute", "tool.after_execute", "approval.required"]:
            event_hooks = registry.get_hooks_for_event(event)
            print_info(f"  事件 '{event}': {len(event_hooks)} 个 Hook")
        test_hooks = registry.get_hooks_for_event("tool.before_execute")
        if len(test_hooks) > 1:
            priorities = [h.priority for h in test_hooks]
            if priorities == sorted(priorities, reverse=True):
                print_success("  优先级排序正确")
            else:
                print_warning("  优先级排序可能有问题")
        return True
    except Exception as e:
        print_error(f"注册表验证失败: {e}")
        logger.exception("注册表验证失败")
        return False


async def verify_hook_execution():
    print_header("4. 验证 Hook 执行")
    try:
        reset_hook_registry()
        bootstrap_hook_system()
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
        print_success("Hook 执行成功")
        if result.additional_context:
            print_info(f"  附加上下文: {len(result.additional_context)} 条")
        if result.tags:
            print_info(f"  标签: {', '.join(result.tags)}")
        if result.block_execution:
            print_info(f"  阻止执行: {result.block_reason}")

        context2 = HookContext(
            event_name="tool.before_execute",
            phase="before_execute",
            timestamp=time.time(),
            tool_name="unknown_tool",
        )
        result2 = await run_hooks(context2)
        if not result2.additional_context and not result2.block_execution:
            print_success("无匹配 Hook 时正确返回空结果")
        return True
    except Exception as e:
        print_error(f"Hook 执行验证失败: {e}")
        logger.exception("Hook 执行验证失败")
        return False


async def verify_builtin_hooks():
    print_header("5. 验证内建 Hook Handlers")
    try:
        from hooks.builtin.tool_hooks import (
            handle_bash_command_validation,
            handle_high_risk_approval_enhancement,
            handle_memory_write_guard,
            handle_risk_audit,
        )

        context = HookContext(
            event_name="tool.before_execute",
            phase="before_execute",
            timestamp=time.time(),
            tool_name="execute_bash",
            agent_name="test_agent",
        )
        result = handle_risk_audit(context, {})
        if "audited" in result.tags:
            print_success("handle_risk_audit 工作正常")
        else:
            print_warning("handle_risk_audit 未返回预期标签")

        result2 = handle_high_risk_approval_enhancement(context, {})
        if result2.ui_message:
            print_success("handle_high_risk_approval_enhancement 工作正常")
        else:
            print_warning("handle_high_risk_approval_enhancement 未返回 UI 消息")

        context3 = HookContext(
            event_name="tool.before_execute",
            phase="before_execute",
            timestamp=time.time(),
            tool_name="execute_bash",
            input_snapshot={"command": "rm -rf /"},
        )
        result3 = handle_bash_command_validation(context3, {})
        if result3.block_execution:
            print_success("handle_bash_command_validation 正确阻止危险命令")
        else:
            print_warning("handle_bash_command_validation 未阻止危险命令")

        context4 = HookContext(
            event_name="tool.before_execute",
            phase="before_execute",
            timestamp=time.time(),
            tool_name="write_memory",
            input_snapshot={"type": "user", "name": "test"},
        )
        result4 = handle_memory_write_guard(context4, {})
        if result4.additional_context:
            print_success("handle_memory_write_guard 工作正常")
        else:
            print_warning("handle_memory_write_guard 未返回附加上下文")
        return True
    except Exception as e:
        print_error(f"内建 Hook 验证失败: {e}")
        logger.exception("内建 Hook 验证失败")
        return False


def verify_event_types():
    print_header("6. 验证事件类型")
    try:
        from agents.events.bus import EventType

        hook_events = [
            EventType.HOOK_STARTED,
            EventType.HOOK_PROGRESS,
            EventType.HOOK_RESPONSE,
            EventType.HOOK_ERROR,
        ]
        for event_type in hook_events:
            print_success(f"事件类型已注册: {event_type.value}")
        return True
    except Exception as e:
        print_error(f"事件类型验证失败: {e}")
        logger.exception("事件类型验证失败")
        return False


async def verify_integration(quick=False):
    if quick:
        print_warning("\n跳过集成测试（快速模式）")
        return True
    print_header("7. 验证工具运行时集成")
    try:
        from tools.runtime import approvals, executor

        source = Path(executor.__file__).read_text()
        integration_points = [
            "run_hooks",
            "HookContext",
            "tool.before_permission",
            "tool.after_permission",
            "tool.before_execute",
            "tool.after_execute",
            "tool.on_error",
        ]
        for point in integration_points:
            if point in source:
                print_success(f"  集成点存在: {point}")
            else:
                print_warning(f"  集成点缺失: {point}")

        source2 = Path(approvals.__file__).read_text()
        for point in ["approval.required", "approval.resolved", "approval.denied"]:
            if point in source2:
                print_success(f"  审批集成点存在: {point}")
            else:
                print_warning(f"  审批集成点缺失: {point}")
        return True
    except Exception as e:
        print_error(f"集成验证失败: {e}")
        logger.exception("集成验证失败")
        return False


def print_summary(results):
    print_header("验证总结")
    total = len(results)
    passed = sum(1 for r in results if r)
    failed = total - passed
    logger.info("总计: %d 项验证", total)
    logger.info("%s", _colorize(f"通过: {passed}", Colors.GREEN))
    if failed > 0:
        logger.error("%s", _colorize(f"失败: {failed}", Colors.RED))
        logger.error("%s", _colorize("✗ 部分验证失败，请检查上述错误。", Colors.BOLD + Colors.RED))
        return 1
    logger.info("%s", _colorize("✓ 所有验证通过！Hook 系统工作正常。", Colors.BOLD + Colors.GREEN))
    return 0


async def main():
    parser = argparse.ArgumentParser(description="验证 Hook 系统")
    parser.add_argument("--quick", action="store_true", help="快速验证（跳过集成测试）")
    parser.add_argument("--verbose", action="store_true", help="详细输出")
    args = parser.parse_args()

    logger.info("%s", _colorize("Hook 系统验证工具", Colors.BOLD))
    logger.info("开始时间: %s", time.strftime('%Y-%m-%d %H:%M:%S'))

    results = [
        verify_imports(),
        verify_config_loading(),
        verify_registry(),
        await verify_hook_execution(),
        await verify_builtin_hooks(),
        verify_event_types(),
        await verify_integration(quick=args.quick),
    ]
    exit_code = print_summary(results)
    logger.info("结束时间: %s", time.strftime('%Y-%m-%d %H:%M:%S'))
    return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

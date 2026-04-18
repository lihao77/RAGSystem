# -*- coding: utf-8 -*-
"""自动扫描 @tool() 装饰器注册的工具模块。"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Any

logger = logging.getLogger(__name__)

_LOCAL_TOOL_MODULES = (
    "tools.local.agent_tools",
    "tools.local.bash_tool",
    "tools.local.builtin_tools",
    "tools.local.code_sandbox",
    "tools.local.document_tools",
    "tools.local.glob_tool",
    "tools.local.grep_tool",
    "tools.local.memory_tools",
    "tools.local.skill_tools",
    "tools.local.task_tools",
    "tools.local.todo_tools",
    "tools.local.web_fetch_tool",
)


def _import_local_tool_modules() -> None:
    """显式导入全量 tools.local.* 模块，确保冻结环境下也能触发 @tool() 注册。"""
    for module_name in _LOCAL_TOOL_MODULES:
        try:
            importlib.import_module(module_name)
            logger.debug("显式导入本地工具模块: %s", module_name)
        except Exception as error:
            logger.warning("显式导入本地工具模块 %s 失败: %s", module_name, error)


def discover_decorated_tools(package_name: str = "tools.local") -> dict[str, Any]:
    """扫描指定包下所有模块，触发 @tool() 装饰器注册。"""
    from tools.decorators import get_decorated_tools

    try:
        package = importlib.import_module(package_name)
    except ImportError as error:
        logger.warning("无法导入工具包 %s: %s", package_name, error)
        return get_decorated_tools()

    if package_name == "tools.local":
        _import_local_tool_modules()

    package_path = getattr(package, "__path__", None)
    if package_path is None:
        logger.warning("包 %s 没有 __path__，跳过扫描", package_name)
        return get_decorated_tools()

    for _, module_name, _ in pkgutil.walk_packages(package_path, prefix=f"{package_name}."):
        try:
            importlib.import_module(module_name)
            logger.debug("已扫描模块: %s", module_name)
        except Exception as error:
            logger.warning("扫描模块 %s 失败: %s", module_name, error)

    decorated = get_decorated_tools()
    if decorated:
        logger.info("自动发现 %d 个装饰器注册的工具: %s", len(decorated), list(decorated.keys()))
    return decorated

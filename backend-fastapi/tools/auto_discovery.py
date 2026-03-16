# -*- coding: utf-8 -*-
"""自动扫描 @tool() 装饰器注册的工具模块。"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Any

logger = logging.getLogger(__name__)


def discover_decorated_tools(package_name: str = "tools.tool_executor_modules") -> dict[str, Any]:
    """
    扫描指定包下所有模块，触发 @tool() 装饰器注册。

    Returns:
        所有已注册的装饰器工具字典
    """
    from tools.decorators import get_decorated_tools

    try:
        package = importlib.import_module(package_name)
    except ImportError as e:
        logger.warning("无法导入工具包 %s: %s", package_name, e)
        return get_decorated_tools()

    package_path = getattr(package, "__path__", None)
    if package_path is None:
        logger.warning("包 %s 没有 __path__，跳过扫描", package_name)
        return get_decorated_tools()

    for importer, module_name, is_pkg in pkgutil.walk_packages(
        package_path, prefix=f"{package_name}."
    ):
        try:
            importlib.import_module(module_name)
            logger.debug("已扫描模块: %s", module_name)
        except Exception as e:
            logger.warning("扫描模块 %s 失败: %s", module_name, e)

    # 扫描不在 tool_executor_modules 包内但使用了 @tool() 的模块
    _extra_modules = ["tools.code_sandbox"]
    for mod_name in _extra_modules:
        try:
            importlib.import_module(mod_name)
            logger.debug("已扫描额外模块: %s", mod_name)
        except Exception as e:
            logger.warning("扫描额外模块 %s 失败: %s", mod_name, e)

    decorated = get_decorated_tools()
    if decorated:
        logger.info("自动发现 %d 个装饰器注册的工具: %s", len(decorated), list(decorated.keys()))
    return decorated

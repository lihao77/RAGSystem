# -*- coding: utf-8 -*-
"""
运行时依赖解析辅助。
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from .container import get_current_runtime_container


def get_runtime_dependency(
    *,
    container_getter: Optional[str] = None,
    container_resolver: Optional[Callable[[Any], Any]] = None,
):
    """从 RuntimeContainer 获取依赖。"""
    container = get_current_runtime_container()
    if container is None:
        raise RuntimeError('RuntimeContainer 未初始化，请先通过 lifespan 启动应用。')
    if container_resolver is not None:
        return container_resolver(container)
    if container_getter is None:
        raise ValueError('container_getter 和 container_resolver 不能同时为空')
    return getattr(container, container_getter)()

# -*- coding: utf-8 -*-
"""
运行时依赖解析辅助。
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Optional

from .container import get_current_runtime_container

logger = logging.getLogger(__name__)

_warned_fallbacks: set[str] = set()


def get_runtime_dependency(
    *,
    container_getter: Optional[str] = None,
    fallback_name: str,
    fallback_factory: Callable[[], Any],
    legacy_getter: Optional[Callable[[], Any]] = None,
    legacy_setter: Optional[Callable[[Any], None]] = None,
    container_resolver: Optional[Callable[[Any], Any]] = None,
):
    """优先从 RuntimeContainer 获取依赖；必要时退回 legacy fallback。"""
    container = get_current_runtime_container()
    if container is not None:
        if container_resolver is not None:
            return container_resolver(container)
        if container_getter is None:
            raise ValueError('container_getter 和 container_resolver 不能同时为空')
        return getattr(container, container_getter)()

    if _runtime_strict_enabled():
        raise RuntimeError(
            f'RuntimeContainer 未初始化，无法解析依赖: {fallback_name}。'
            f'请先通过 app/runtime 初始化运行时容器。'
        )

    if fallback_name not in _warned_fallbacks:
        logger.warning(
            '依赖 %s 正在使用 legacy fallback；建议改为通过 RuntimeContainer 装配。',
            fallback_name,
        )
        _warned_fallbacks.add(fallback_name)

    if legacy_getter is not None:
        instance = legacy_getter()
        if instance is not None:
            return instance

    instance = fallback_factory()
    if legacy_setter is not None:
        legacy_setter(instance)
    return instance


def reset_runtime_fallback_warnings() -> None:
    _warned_fallbacks.clear()


def _runtime_strict_enabled() -> bool:
    value = os.environ.get('RAGSYSTEM_RUNTIME_STRICT', '')
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}

# -*- coding: utf-8 -*-
"""
运行时依赖解析辅助。
"""

from __future__ import annotations

import inspect
import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .container import get_current_runtime_container

logger = logging.getLogger(__name__)

_warned_fallbacks: set[str] = set()
_fallback_records: dict[tuple[str, Optional[str], Optional[str]], int] = {}
_fallback_state_lock = threading.RLock()


@dataclass(frozen=True)
class RuntimeFallbackRecord:
    dependency_name: str
    accessor: Optional[str]
    caller: Optional[str]
    count: int


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

    accessor, caller = _capture_runtime_callsite()

    if _runtime_strict_enabled():
        location_message = ''
        context = _format_runtime_fallback_context(accessor=accessor, caller=caller)
        if context:
            location_message = f'调用链: {context}。'
        raise RuntimeError(
            f'RuntimeContainer 未初始化，无法解析依赖: {fallback_name}。'
            f'{location_message}'
            f'请先通过 app/runtime 初始化运行时容器。'
        )

    _record_runtime_fallback(fallback_name, accessor=accessor, caller=caller)

    should_warn = False
    with _fallback_state_lock:
        if fallback_name not in _warned_fallbacks:
            _warned_fallbacks.add(fallback_name)
            should_warn = True

    if should_warn:
        logger.warning(
            '依赖 %s 正在使用 legacy fallback%s；建议改为通过 RuntimeContainer 装配。',
            fallback_name,
            _format_runtime_fallback_context(accessor=accessor, caller=caller),
        )

    if legacy_getter is not None:
        instance = legacy_getter()
        if instance is not None:
            return instance

    instance = fallback_factory()
    if legacy_setter is not None:
        legacy_setter(instance)
    return instance


def reset_runtime_fallback_warnings() -> None:
    with _fallback_state_lock:
        _warned_fallbacks.clear()


def reset_runtime_fallback_tracking() -> None:
    with _fallback_state_lock:
        _warned_fallbacks.clear()
        _fallback_records.clear()


def get_runtime_fallback_stats() -> list[dict[str, Any]]:
    with _fallback_state_lock:
        records = [
            RuntimeFallbackRecord(
                dependency_name=dependency_name,
                accessor=accessor,
                caller=caller,
                count=count,
            )
            for (dependency_name, accessor, caller), count in _fallback_records.items()
        ]

    records.sort(
        key=lambda record: (
            -record.count,
            record.dependency_name,
            record.accessor or '',
            record.caller or '',
        )
    )
    return [record.__dict__.copy() for record in records]


def _runtime_strict_enabled() -> bool:
    value = os.environ.get('RAGSYSTEM_RUNTIME_STRICT', '')
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def _record_runtime_fallback(
    dependency_name: str,
    *,
    accessor: Optional[str],
    caller: Optional[str],
) -> None:
    key = (dependency_name, accessor, caller)
    with _fallback_state_lock:
        _fallback_records[key] = _fallback_records.get(key, 0) + 1


def _format_runtime_fallback_context(*, accessor: Optional[str], caller: Optional[str]) -> str:
    parts: list[str] = []
    if accessor:
        parts.append(f'访问入口: {accessor}')
    if caller:
        parts.append(f'上游调用: {caller}')
    if not parts:
        return ''
    return '（' + '；'.join(parts) + '）'


def _capture_runtime_callsite() -> tuple[Optional[str], Optional[str]]:
    current_frame = inspect.currentframe()
    if current_frame is None:
        return None, None

    helper_frame = current_frame.f_back
    accessor_frame = helper_frame.f_back if helper_frame is not None else None
    caller_frame = accessor_frame.f_back if accessor_frame is not None else None

    try:
        return _format_frame(accessor_frame), _format_frame(caller_frame)
    finally:
        del current_frame
        del helper_frame
        del accessor_frame
        del caller_frame


def _format_frame(frame) -> Optional[str]:
    if frame is None:
        return None

    module_name = frame.f_globals.get('__name__') or '<unknown>'
    function_name = frame.f_code.co_name
    line_number = frame.f_lineno
    return f'{module_name}.{function_name}:{line_number}'

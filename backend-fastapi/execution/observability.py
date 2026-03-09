# -*- coding: utf-8 -*-
"""Execution 观测上下文与字段辅助。"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

EXECUTION_OBSERVABILITY_KEYS = (
    'task_id',
    'session_id',
    'run_id',
    'execution_kind',
    'request_id',
)


@dataclass(frozen=True, slots=True)
class ExecutionObservabilityContext:
    task_id: str
    execution_kind: str
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    request_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            key: value
            for key in EXECUTION_OBSERVABILITY_KEYS
            if (value := getattr(self, key)) is not None
        }


_current_execution_observability: ContextVar[Optional[ExecutionObservabilityContext]] = ContextVar(
    'current_execution_observability',
    default=None,
)


def get_current_execution_observability() -> Optional[ExecutionObservabilityContext]:
    return _current_execution_observability.get()


def get_current_execution_observability_fields() -> Dict[str, Any]:
    current = get_current_execution_observability()
    return current.to_dict() if current is not None else {}


@contextmanager
def execution_observability_scope(context: ExecutionObservabilityContext):
    token = _current_execution_observability.set(context)
    try:
        yield context
    finally:
        _current_execution_observability.reset(token)


def extract_observability_fields(payload: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {}

    fields: Dict[str, Any] = {}
    nested = payload.get('_execution')
    if isinstance(nested, Mapping):
        for key in EXECUTION_OBSERVABILITY_KEYS:
            value = nested.get(key)
            if value is not None:
                fields[key] = value

    for key in EXECUTION_OBSERVABILITY_KEYS:
        value = payload.get(key)
        if value is not None:
            fields[key] = value
    return fields


def merge_observability_metadata(
    metadata: Optional[Mapping[str, Any]],
    *,
    task_id: str,
    execution_kind: str,
    session_id: Optional[str] = None,
    run_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    merged = dict(metadata or {})
    fields = {
        'task_id': task_id,
        'session_id': session_id,
        'run_id': run_id,
        'execution_kind': execution_kind,
        'request_id': request_id,
    }
    for key, value in fields.items():
        if value is not None:
            merged[key] = value
    merged['_execution'] = {
        key: value
        for key, value in fields.items()
        if value is not None
    }
    return merged


def attach_execution_metadata(
    payload: Optional[Mapping[str, Any]],
    *,
    task_id: Optional[str] = None,
    execution_kind: Optional[str] = None,
    session_id: Optional[str] = None,
    run_id: Optional[str] = None,
    request_id: Optional[str] = None,
    observability: Optional[ExecutionObservabilityContext] = None,
) -> Dict[str, Any]:
    merged = dict(payload or {})
    combined = extract_observability_fields(merged)

    if observability is not None:
        combined.update(observability.to_dict())

    explicit_fields = {
        'task_id': task_id,
        'session_id': session_id,
        'run_id': run_id,
        'execution_kind': execution_kind,
        'request_id': request_id,
    }
    for key, value in explicit_fields.items():
        if value is not None:
            combined[key] = value

    if combined:
        merged['_execution'] = combined
    return merged


def apply_observability_fields(target: Dict[str, Any], source: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    for key, value in extract_observability_fields(source).items():
        if target.get(key) is None:
            target[key] = value
    return target


def ensure_request_id(request_id: Optional[str] = None) -> str:
    value = str(request_id or '').strip()
    return value or str(uuid.uuid4())


def format_observability_for_log(fields: Optional[Mapping[str, Any]] = None) -> str:
    resolved = dict(fields or get_current_execution_observability_fields())
    parts = [f'{key}={resolved[key]}' for key in EXECUTION_OBSERVABILITY_KEYS if resolved.get(key)]
    return ' '.join(parts)

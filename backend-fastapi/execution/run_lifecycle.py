# -*- coding: utf-8 -*-
"""Small helpers for session run notifications and cleanup."""

from __future__ import annotations

import logging
from typing import Any, Optional

from agents.events.bus import Event, EventType

logger = logging.getLogger(__name__)


def publish_session_run_started(
    session_id: str,
    run_id: str,
    *,
    source: str,
    data: Optional[dict[str, Any]] = None,
    event_bus=None,
) -> None:
    """Notify session-level realtime consumers that a run is available."""
    payload = {'run_id': run_id, 'source': source}
    if data:
        payload.update(data)
    try:
        bus = event_bus
        if bus is None:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                return
            bus = container.get_event_bus()
        bus.publish(Event(
            type=EventType.SESSION_RUN_STARTED,
            data=payload,
            session_id=session_id,
        ))
    except Exception as exc:
        logger.debug('发布 session.run_started 失败 session=%s run_id=%s: %s', session_id, run_id, exc)


def publish_session_updated(
    session_id: str,
    run_id: str,
    *,
    source: str,
    data: Optional[dict[str, Any]] = None,
    event_bus=None,
) -> None:
    """Notify session-level realtime consumers that persisted session state changed."""
    payload = {'run_id': run_id, 'source': source}
    if data:
        payload.update(data)
    try:
        bus = event_bus
        if bus is None:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                return
            bus = container.get_event_bus()
        bus.publish(Event(
            type=EventType.SESSION_UPDATED,
            data=payload,
            session_id=session_id,
        ))
    except Exception as exc:
        logger.debug('发布 session.updated 失败 session=%s run_id=%s: %s', session_id, run_id, exc)

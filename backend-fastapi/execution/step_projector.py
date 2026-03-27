# -*- coding: utf-8 -*-
"""Project raw run events into canonical execution.step events."""

from __future__ import annotations

from typing import Any, Dict, Optional

from agents.events.bus import Event, EventPriority, EventType
from execution.observability import attach_execution_metadata, extract_observability_fields


_PROJECTABLE_EVENT_TYPES = [
    EventType.RUN_START,
    EventType.RUN_END,
    EventType.INTENT_DELTA,
    EventType.INTENT_COMPLETE,
    EventType.CALL_AGENT_START,
    EventType.CALL_AGENT_END,
    EventType.CALL_TOOL_START,
    EventType.CALL_TOOL_END,
    EventType.CHART_GENERATED,
    EventType.MAP_GENERATED,
]


class StepProjector:
    """Listen to raw agent events and republish canonical execution.step events."""

    @staticmethod
    def _resolve_display_agent_name(data: Dict[str, Any], fallback_agent_name: Optional[str]) -> str:
        metadata = data.get('metadata') or {}
        return data.get('agent_name') or metadata.get('agent_name') or fallback_agent_name or ''

    @classmethod
    def _resolve_display_agent_display_name(cls, data: Dict[str, Any], fallback_agent_name: Optional[str]) -> str:
        metadata = data.get('metadata') or {}
        display_agent_name = cls._resolve_display_agent_name(data, fallback_agent_name)
        return data.get('agent_display_name') or metadata.get('agent_display_name') or display_agent_name

    @staticmethod
    def _make_run_step_id(owner_id: Optional[str]) -> str:
        return f"{owner_id or 'run'}:run"

    @staticmethod
    def _make_call_step_id(call_id: Optional[str], fallback: str) -> str:
        return f"{call_id or fallback}:call"

    @staticmethod
    def _make_round_step_id(owner_call_id: Optional[str], round_value: Optional[int], fallback: str) -> str:
        if round_value is not None:
            return f"{owner_call_id or fallback}:round:{round_value}"
        return f"{owner_call_id or fallback}:round"

    @classmethod
    def _resolve_step_ids(
        cls,
        *,
        kind: str,
        event_type: str,
        call_id: Optional[str],
        parent_call_id: Optional[str],
        round_value: Optional[int],
        run_id: Optional[str],
    ) -> tuple[Optional[str], Optional[str]]:
        root_owner = parent_call_id or call_id or run_id or 'run'
        if kind == 'run':
            return cls._make_run_step_id(call_id or run_id), None
        if kind == 'subtask':
            return (
                cls._make_call_step_id(call_id, 'subtask'),
                cls._make_round_step_id(parent_call_id or run_id, round_value, 'run'),
            )
        if kind == 'intent':
            owner_call_id = call_id or parent_call_id or run_id
            parent_step_id = (
                cls._make_run_step_id(owner_call_id or run_id)
                if parent_call_id is None
                else cls._make_call_step_id(call_id, 'subtask')
            )
            return cls._make_round_step_id(owner_call_id, round_value, 'step'), parent_step_id
        if kind == 'tool':
            return (
                f"{call_id or event_type}:tool",
                cls._make_round_step_id(parent_call_id or run_id or root_owner, round_value, 'run'),
            )
        if kind == 'visualization':
            return (
                f"{event_type}:{call_id or run_id or 'viz'}",
                cls._make_round_step_id(parent_call_id or call_id or run_id, round_value, 'run'),
            )
        return None, None

    def __init__(self, *, event_bus, session_id: str):
        self.event_bus = event_bus
        self.session_id = session_id
        self._subscription_id: Optional[str] = None

    def subscribe(self) -> str:
        if self._subscription_id:
            return self._subscription_id
        self._subscription_id = self.event_bus.subscribe(
            event_types=_PROJECTABLE_EVENT_TYPES,
            handler=self._handle_event,
            filter_func=lambda event: event.session_id == self.session_id,
            priority=100,
        )
        return self._subscription_id

    def unsubscribe(self) -> None:
        if not self._subscription_id:
            return
        try:
            self.event_bus.unsubscribe(self._subscription_id)
        finally:
            self._subscription_id = None

    def _handle_event(self, event: Event) -> None:
        step = self.project_event(event)
        if not step:
            return

        observability = extract_observability_fields(event.data or {})
        payload = attach_execution_metadata(step, **observability)
        self.event_bus.publish(Event(
            type=EventType.EXECUTION_STEP,
            data=payload,
            priority=event.priority if isinstance(event.priority, EventPriority) else EventPriority.NORMAL,
            session_id=event.session_id,
            trace_id=event.trace_id,
            span_id=event.span_id,
            agent_name=payload.get('agent_name') or event.agent_name,
            call_id=payload.get('call_id') or event.call_id,
            parent_call_id=payload.get('parent_call_id') or event.parent_call_id,
        ))

    def project_event(self, event: Event) -> Optional[Dict[str, Any]]:
        event_type = event.type.value if hasattr(event.type, 'value') else str(event.type)
        data = event.data or {}
        agent_name = self._resolve_display_agent_name(data, event.agent_name)
        agent_display_name = self._resolve_display_agent_display_name(data, event.agent_name)
        call_id = event.call_id
        parent_call_id = event.parent_call_id
        run_id = data.get('run_id')
        round_value = data.get('round')
        base = {
            'node_id': call_id,
            'parent_node_id': parent_call_id,
            'call_id': call_id,
            'parent_call_id': parent_call_id,
            'agent_name': agent_name,
            'agent_display_name': agent_display_name,
            'child_agent_id': data.get('child_agent_id'),
            'mode': data.get('mode'),
            'source_event_type': event_type,
            'timestamp': event.timestamp,
            'event_id': event.event_id,
        }

        if event.type == EventType.RUN_START:
            run_id = data.get('run_id')
            metadata = data.get('metadata') or {}
            description = (metadata.get('task') or data.get('task') or '').strip()
            display_agent_name = self._resolve_display_agent_name(data, event.agent_name)
            display_agent_display_name = self._resolve_display_agent_display_name(data, event.agent_name)
            step_id, parent_step_id = self._resolve_step_ids(
                kind='run',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'agent_name': display_agent_name,
                'agent_display_name': display_agent_display_name,
                'kind': 'run',
                'phase': 'start',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'node_id': call_id or run_id,
                'call_id': call_id or run_id,
                'run_id': run_id,
                'description': description,
                'status': 'running',
            }

        if event.type == EventType.RUN_END:
            run_id = data.get('run_id')
            display_agent_name = self._resolve_display_agent_name(data, event.agent_name)
            display_agent_display_name = self._resolve_display_agent_display_name(data, event.agent_name)
            status = data.get('status') or 'completed'
            if status == 'success':
                status = 'completed'
            step_id, parent_step_id = self._resolve_step_ids(
                kind='run',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'agent_name': display_agent_name,
                'agent_display_name': display_agent_display_name,
                'kind': 'run',
                'phase': 'end',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'node_id': call_id or run_id,
                'call_id': call_id or run_id,
                'run_id': run_id,
                'status': status,
                'result': data.get('summary'),
                'result_preview': data.get('summary'),
            }

        if event.type == EventType.CALL_AGENT_START:
            if parent_call_id is None:
                return None
            step_id, parent_step_id = self._resolve_step_ids(
                kind='subtask',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'subtask',
                'phase': 'start',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'agent_display_name': data.get('agent_display_name') or agent_display_name,
                'description': data.get('description') or data.get('task') or '',
                'round': data.get('round'),
                'round_index': data.get('round_index'),
                'order': data.get('order'),
                'status': 'running',
            }

        if event.type == EventType.CALL_AGENT_END:
            if parent_call_id is None:
                return None
            step_id, parent_step_id = self._resolve_step_ids(
                kind='subtask',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'subtask',
                'phase': 'end',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'agent_display_name': data.get('agent_display_name') or agent_name,
                'order': data.get('order'),
                'status': 'error' if data.get('success') is False else 'success',
                'result': data.get('result_summary') or data.get('result'),
                'result_preview': data.get('result_summary') or data.get('result'),
            }

        if event.type == EventType.INTENT_DELTA:
            step_id, parent_step_id = self._resolve_step_ids(
                kind='intent',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'intent',
                'phase': 'delta',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'agent_display_name': agent_display_name,
                'round': data.get('round'),
                'status': 'running',
                'content': data.get('content') or '',
            }

        if event.type == EventType.INTENT_COMPLETE:
            step_id, parent_step_id = self._resolve_step_ids(
                kind='intent',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'intent',
                'phase': 'complete',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'agent_display_name': agent_display_name,
                'round': data.get('round'),
                'status': 'completed',
                'content': data.get('content') or '',
            }

        if event.type == EventType.CALL_TOOL_START:
            step_id, parent_step_id = self._resolve_step_ids(
                kind='tool',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'tool',
                'phase': 'start',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'agent_display_name': agent_display_name,
                'tool_name': data.get('tool_name'),
                'arguments': data.get('arguments') or {},
                'round': data.get('round'),
                'status': 'running',
            }

        if event.type == EventType.CALL_TOOL_END:
            preview = data.get('result_preview')
            if preview is None:
                preview = data.get('result')
            raw_result = data.get('raw_result')
            step_id, parent_step_id = self._resolve_step_ids(
                kind='tool',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'tool',
                'phase': 'end',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'agent_display_name': agent_display_name,
                'tool_name': data.get('tool_name'),
                'round': data.get('round'),
                'status': 'error' if data.get('success') is False else 'success',
                'result': preview,
                'result_preview': preview,
                'raw_result': raw_result,
                'raw_result_ref': data.get('raw_result_ref') or {},
                'raw_result_available': bool(data.get('raw_result_available') or raw_result is not None),
                'elapsed_time': data.get('elapsed_time') or data.get('execution_time'),
                'resource_refs': data.get('resource_refs') or [],
            }

        if event.type in (EventType.CHART_GENERATED, EventType.MAP_GENERATED):
            step_id, parent_step_id = self._resolve_step_ids(
                kind='visualization',
                event_type=event_type,
                call_id=call_id,
                parent_call_id=parent_call_id,
                round_value=round_value,
                run_id=run_id,
            )
            return {
                **base,
                'kind': 'visualization',
                'phase': 'complete',
                'step_id': step_id,
                'parent_step_id': parent_step_id,
                'visualization_type': 'chart' if event.type == EventType.CHART_GENERATED else 'map',
                'status': 'completed',
                'data': data,
            }

        return None

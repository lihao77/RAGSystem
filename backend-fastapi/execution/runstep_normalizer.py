# -*- coding: utf-8 -*-
"""Normalize raw persisted event steps into a cleaner run-step contract."""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def normalize_run_steps(
    raw_steps: List[Dict[str, Any]],
    *,
    entry_agent_name: str = 'orchestrator_agent',
) -> List[Dict[str, Any]]:
    """Return a canonical run-step sequence derived from persisted raw events."""
    normalized: List[Dict[str, Any]] = []
    if not raw_steps:
        return normalized

    for step in raw_steps:
        payload = step.get('payload') or {}
        data = payload.get('data') or {}
        event_type = step.get('step_type') or payload.get('type')
        agent_name = payload.get('agent_name') or data.get('agent_name')
        call_id = payload.get('call_id')
        parent_call_id = payload.get('parent_call_id')
        step_order = step.get('step_order')

        if event_type == 'run.start':
            normalized.append({
                'kind': 'run_start',
                'step_order': step_order,
                'run_id': payload.get('run_id') or data.get('run_id'),
                'agent_name': agent_name or entry_agent_name,
                'source_event_type': event_type,
            })
        elif event_type == 'run.end':
            normalized.append({
                'kind': 'run_end',
                'step_order': step_order,
                'run_id': payload.get('run_id') or data.get('run_id'),
                'agent_name': agent_name or entry_agent_name,
                'status': data.get('status'),
                'summary': data.get('summary'),
                'source_event_type': event_type,
            })
        elif event_type == 'agent.start':
            normalized.append({
                'kind': 'subtask_start' if parent_call_id else 'agent_start',
                'step_order': step_order,
                'agent_name': agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'round': data.get('round'),
                'description': data.get('description') or data.get('task'),
                'task': data.get('task'),
                'source_event_type': event_type,
            })
        elif event_type == 'agent.end':
            normalized.append({
                'kind': 'subtask_end' if parent_call_id else 'agent_end',
                'step_order': step_order,
                'agent_name': agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'result_summary': data.get('result_summary') or data.get('result'),
                'execution_time': data.get('execution_time'),
                'source_event_type': event_type,
            })
        elif event_type == 'agent.thinking_complete':
            normalized.append({
                'kind': 'subtask_thought' if parent_call_id else 'agent_thought',
                'step_order': step_order,
                'agent_name': agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'round': data.get('round'),
                'content': data.get('content'),
                'source_event_type': event_type,
            })
        elif event_type == 'react.intermediate':
            msg_type = data.get('msg_type')
            role = data.get('role')
            if role == 'assistant' and msg_type == 'thought':
                normalized.append({
                    'kind': 'agent_thought',
                    'step_order': step_order,
                    'agent_name': agent_name or entry_agent_name,
                    'call_id': call_id,
                    'parent_call_id': parent_call_id,
                    'round': data.get('round'),
                    'content': data.get('content'),
                    'source_event_type': event_type,
                })
        elif event_type == 'call.agent.start':
            normalized.append({
                'kind': 'subtask_start',
                'step_order': step_order,
                'agent_name': data.get('agent_name') or agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'round': data.get('round'),
                'round_index': data.get('round_index'),
                'order': data.get('order'),
                'description': data.get('description'),
                'source_event_type': event_type,
            })
        elif event_type == 'call.agent.end':
            normalized.append({
                'kind': 'subtask_end',
                'step_order': step_order,
                'agent_name': data.get('agent_name') or agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'order': data.get('order'),
                'status': 'error' if data.get('success') is False else 'success',
                'result_summary': data.get('result_summary') or data.get('result'),
                'source_event_type': event_type,
            })
        elif event_type == 'call.tool.start':
            normalized.append({
                'kind': 'tool_start',
                'step_order': step_order,
                'agent_name': agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'tool_name': data.get('tool_name'),
                'arguments': data.get('arguments'),
                'source_event_type': event_type,
            })
        elif event_type == 'call.tool.end':
            normalized.append({
                'kind': 'tool_end',
                'step_order': step_order,
                'agent_name': agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'tool_name': data.get('tool_name'),
                'result': data.get('result'),
                'elapsed_time': data.get('elapsed_time') or data.get('execution_time'),
                'source_event_type': event_type,
            })
        elif event_type in ('visualization.chart', 'visualization.map'):
            normalized.append({
                'kind': 'visualization',
                'step_order': step_order,
                'agent_name': agent_name,
                'call_id': call_id,
                'parent_call_id': parent_call_id,
                'visualization_type': 'chart' if event_type.endswith('chart') else 'map',
                'data': data,
                'source_event_type': event_type,
            })

    return normalized

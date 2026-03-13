# -*- coding: utf-8 -*-
"""Normalize raw persisted event steps into a cleaner run-step contract."""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def _merge_into_last_intent_step(
    normalized: List[Dict[str, Any]],
    *,
    kind: str,
    call_id: Optional[str],
    parent_call_id: Optional[str],
    round_value: Optional[int],
    content: Any,
    actions: Any,
    full_response: Any,
    source_event_type: str,
) -> bool:
    if not normalized:
        return False

    last = normalized[-1]
    if last.get('kind') != kind:
        return False
    if last.get('call_id') != call_id or last.get('parent_call_id') != parent_call_id:
        return False
    if last.get('round') != round_value:
        return False

    if content and not last.get('content'):
        last['content'] = content
    if actions:
        last['actions'] = actions
    if full_response:
        last['full_response'] = full_response
    last['source_event_type'] = source_event_type
    return True


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
        elif event_type in ('agent.intent_complete', 'agent.thinking_complete'):
            normalized.append({
                'kind': 'subtask_intent' if parent_call_id else 'agent_intent',
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
            # 兼容旧数据库中遗留的历史记录（新版已不再持久化此事件，见 runstep_handler.py）。
            # 若将来前端 executionStepsToExecutionState 接收到此 kind，
            # 必须做同 round 去重（不能无条件新建 reactStep），否则会出现重复思考块。
            if role == 'assistant' and msg_type in ('thought', 'assistant_response'):
                kind = 'subtask_intent' if parent_call_id else 'agent_intent'
                if _merge_into_last_intent_step(
                    normalized,
                    kind=kind,
                    call_id=call_id,
                    parent_call_id=parent_call_id,
                    round_value=data.get('round'),
                    content=data.get('content'),
                    actions=data.get('actions'),
                    full_response=data.get('full_response'),
                    source_event_type=event_type,
                ):
                    continue
                normalized.append({
                    'kind': kind,
                    'step_order': step_order,
                    'agent_name': agent_name or entry_agent_name,
                    'call_id': call_id,
                    'parent_call_id': parent_call_id,
                    'round': data.get('round'),
                    'content': data.get('content'),
                    'actions': data.get('actions'),
                    'full_response': data.get('full_response'),
                    'source_event_type': event_type,
                })
        elif event_type == 'call.agent.start':
            normalized.append({
                'kind': 'subtask_start',
                'step_order': step_order,
                'agent_name': data.get('agent_name') or agent_name,
                'agent_display_name': data.get('agent_display_name'),
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

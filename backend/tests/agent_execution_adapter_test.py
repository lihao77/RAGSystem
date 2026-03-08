# -*- coding: utf-8 -*-
"""AgentExecutionAdapter 测试。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from agents.core.models import AgentResponse
from agents.events.bus import Event, EventBus, EventType
from agents.task_registry import TaskRegistry
from execution import attach_execution_metadata
from execution import InProcessExecutionRunner, ExecutionStatus
from execution.adapters.agent_execution import AgentExecutionAdapter
from services.execution_service import ExecutionService


class _FakeSessionManager:
    def __init__(self):
        self.buses = {}

    def get_or_create(self, session_id: str):
        bus = self.buses.get(session_id)
        if bus is None:
            bus = EventBus(enable_persistence=True)
            self.buses[session_id] = bus
        return bus


class _FakeStore:
    def __init__(self):
        self.sessions = []
        self.messages = []
        self.run_steps = []
        self.updated_run_steps = []
        self.compressions = []

    def create_session(self, session_id: str, user_id=None):
        self.sessions.append({'session_id': session_id, 'user_id': user_id})

    def add_message(self, session_id: str, role: str, content: str, metadata=None):
        message = {
            'id': len(self.messages) + 1,
            'seq': len(self.messages) + 1,
            'session_id': session_id,
            'role': role,
            'content': content,
            'metadata': metadata or {},
        }
        self.messages.append(message)
        return message

    def add_run_step(self, **payload):
        self.run_steps.append(payload)

    def update_run_steps_message_id(self, session_id: str, run_id: str, message_id: int):
        self.updated_run_steps.append((session_id, run_id, message_id))

    def insert_compression_message(self, **payload):
        self.compressions.append(payload)


class _FakeMasterAgent:
    def __init__(self, response: AgentResponse):
        self._response = response
        self.calls = []

    def execute(self, task, context):
        self.calls.append((task, context.session_id))
        return self._response


class _FakeOrchestrator:
    def __init__(self, master_agent):
        self.agents = {'master_agent_v2': master_agent}
        self._metrics_collector = None


def _noop_history_loader(context, session_id: str, limit: int = 50):
    return None


class AgentExecutionAdapterTest(unittest.TestCase):
    def _build_adapter(self):
        registry = TaskRegistry()
        service = ExecutionService(
            task_registry=registry,
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        return AgentExecutionAdapter(execution_service=service), registry

    def test_start_stream_execution_completes_successfully(self) -> None:
        adapter, registry = self._build_adapter()
        store = _FakeStore()
        orchestrator = _FakeOrchestrator(
            _FakeMasterAgent(
                AgentResponse(success=True, content='done', agent_name='master_agent_v2')
            )
        )

        started = adapter.start_stream_execution(
            task='hello',
            session_id='session-success',
            user_id='user-1',
            llm_override=None,
            request_id='req-success',
            conversation_store=store,
            orchestrator=orchestrator,
            history_loader=_noop_history_loader,
        )
        self.assertTrue(started.started)
        self.assertIsNotNone(started.handle)
        self.assertEqual(started.request_id, 'req-success')

        result = started.handle.join(timeout=1)
        started.sse_adapter.stop()

        self.assertIsNotNone(result)
        self.assertEqual(registry.get_status('session-success')['raw_status'], 'completed')
        self.assertEqual(result.status, ExecutionStatus.COMPLETED)
        self.assertEqual(store.messages[0]['role'], 'user')
        self.assertEqual(store.messages[-1]['role'], 'assistant')

    def test_start_stream_execution_rejects_active_session(self) -> None:
        adapter, registry = self._build_adapter()
        registry.register_task(
            session_id='session-busy',
            run_id='run-busy',
            task='busy',
            status='running',
            execution_kind='agent_stream',
            concurrency_key='session:session-busy',
        )

        started = adapter.start_stream_execution(
            task='new',
            session_id='session-busy',
            user_id='user-2',
            llm_override=None,
            request_id='req-busy',
            conversation_store=_FakeStore(),
            orchestrator=_FakeOrchestrator(_FakeMasterAgent(AgentResponse(success=True, content='ok'))),
            history_loader=_noop_history_loader,
        )

        self.assertFalse(started.started)
        self.assertIn('该会话正在执行任务', started.error_message)

    def test_start_stream_execution_marks_interrupted_response(self) -> None:
        adapter, registry = self._build_adapter()
        store = _FakeStore()
        orchestrator = _FakeOrchestrator(
            _FakeMasterAgent(
                AgentResponse(
                    success=False,
                    content='[已停止生成]',
                    error='interrupted',
                    agent_name='master_agent_v2',
                )
            )
        )

        started = adapter.start_stream_execution(
            task='stop',
            session_id='session-interrupted',
            user_id='user-3',
            llm_override=None,
            request_id='req-stop',
            conversation_store=store,
            orchestrator=orchestrator,
            history_loader=_noop_history_loader,
        )
        self.assertTrue(started.started)

        result = started.handle.join(timeout=1)
        started.sse_adapter.stop()

        self.assertIsNotNone(result)
        self.assertEqual(result.status, ExecutionStatus.INTERRUPTED)
        self.assertEqual(registry.get_status('session-interrupted')['raw_status'], 'interrupted')

    def test_event_to_payload_flattens_execution_fields(self) -> None:
        event = Event(
            type=EventType.RUN_START,
            data=attach_execution_metadata(
                {'run_id': 'run-1'},
                task_id='task-1',
                session_id='session-1',
                run_id='run-1',
                execution_kind='agent_stream',
                request_id='req-1',
            ),
            session_id='session-1',
            agent_name='master_agent_v2',
        )

        payload = AgentExecutionAdapter._event_to_payload(event)

        self.assertEqual(payload['task_id'], 'task-1')
        self.assertEqual(payload['run_id'], 'run-1')
        self.assertEqual(payload['execution_kind'], 'agent_stream')
        self.assertEqual(payload['request_id'], 'req-1')


if __name__ == '__main__':
    unittest.main()

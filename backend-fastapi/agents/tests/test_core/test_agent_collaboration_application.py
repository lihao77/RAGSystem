# -*- coding: utf-8 -*-

import pytest
from types import SimpleNamespace

from agents.core.models import AgentResponse
from application.agent_collaboration import AgentCollaborationApplication


class _FakeCheckpointManager:
    def __init__(self):
        self.checkpoint = {
            'checkpoint_id': 'cp-1',
            'agent_name': 'qa_agent',
            'round': 2,
            'messages': [
                {'role': 'user', 'content': '原始任务', 'metadata': {}, 'seq': 1},
                {'role': 'assistant', 'content': '中间过程', 'metadata': {}, 'seq': 2},
            ],
        }

    def load_checkpoint(self, checkpoint_id):
        assert checkpoint_id == 'cp-1'
        return dict(self.checkpoint)

    def get_latest_checkpoint(self, session_id, agent_name=None):
        assert session_id == 'session-1'
        return dict(self.checkpoint)

    def list_checkpoints(self, session_id, agent_name=None, limit=10):
        return [dict(self.checkpoint)]


class _FakeResolvedAgent:
    def __init__(self, name='qa_agent'):
        self.name = name
        self.calls = []

    def execute(self, task, context):
        self.calls.append({'task': task, 'context': context})
        return AgentResponse(
            success=True,
            content='恢复后的答案',
            agent_name=self.name,
            execution_time=0.1,
        )


class _FakeExecutionService:
    def __init__(self):
        self.invocations = []
        self.resolved_calls = []
        self.resolved_agent = _FakeResolvedAgent()

    def invoke_routed_agent(self, **kwargs):
        self.invocations.append(kwargs)
        return SimpleNamespace(
            response=AgentResponse(
                success=True,
                content='重试答案',
                agent_name='qa_agent',
                execution_time=0.2,
            ),
            run_id='run-retry',
        )

    def resolve_routed_root_agent(self, **kwargs):
        self.resolved_calls.append(kwargs)
        return self.resolved_agent


class _FakeRuntimeService:
    def __init__(self):
        self.execution_service = _FakeExecutionService()

    def build_context(self, *, session_id, user_id=None, limit=200, run_id=None, **kwargs):
        del kwargs, limit
        messages = []

        def add_message(role, content, metadata=None, seq=None):
            messages.append({
                'role': role,
                'content': content,
                'metadata': metadata or {},
                'seq': seq,
            })

        return SimpleNamespace(
            session_id=session_id,
            user_id=user_id,
            metadata={'run_id': run_id},
            messages=messages,
            add_message=add_message,
        )

    def get_agent_execution_service(self):
        return self.execution_service


class _FakeSessionApplication:
    def __init__(self):
        self.assistant_messages = []
        self.retry_payload = {
            'deleted': 2,
            'task': '修改后的任务',
            'message': {'id': 'msg-user-1'},
        }
        self.prepare_retry_error = None

    def add_assistant_message(self, *, session_id, content, metadata=None):
        self.assistant_messages.append({
            'session_id': session_id,
            'content': content,
            'metadata': metadata or {},
        })

    def prepare_retry(self, *, session_id, after_seq, modify_user_message=None):
        if self.prepare_retry_error is not None:
            raise self.prepare_retry_error
        assert session_id == 'session-1'
        assert after_seq == 3
        assert modify_user_message == '修改后的任务'
        return dict(self.retry_payload)


def test_recover_session_routes_via_service_but_preserves_checkpoint_context(monkeypatch):
    cleaned = []
    monkeypatch.setattr('application.agent_collaboration.cleanup_run', lambda run_id: cleaned.append(run_id))

    runtime = _FakeRuntimeService()
    session_app = _FakeSessionApplication()
    app = AgentCollaborationApplication(
        checkpoint_manager=_FakeCheckpointManager(),
        runtime_service=runtime,
        session_application=session_app,
    )

    result = app.recover_session('session-1', {'checkpoint_id': 'cp-1', 'user_id': 'user-1'})

    assert runtime.execution_service.resolved_calls[0]['preferred_agent'] == 'qa_agent'
    assert runtime.execution_service.resolved_agent.calls[0]['task'] == '原始任务'
    assert len(runtime.execution_service.resolved_agent.calls[0]['context'].messages) == 2
    assert cleaned == [runtime.execution_service.resolved_agent.calls[0]['context'].metadata['run_id']]
    assert session_app.assistant_messages[0]['metadata']['recovered_from'] == 'cp-1'
    assert result['answer'] == '恢复后的答案'


def test_rollback_and_retry_uses_unified_execution_service():
    runtime = _FakeRuntimeService()
    session_app = _FakeSessionApplication()
    app = AgentCollaborationApplication(
        checkpoint_manager=_FakeCheckpointManager(),
        runtime_service=runtime,
        session_application=session_app,
    )

    result = app.rollback_and_retry(
        'session-1',
        {'after_seq': 3, 'modify_user_message': '修改后的任务', 'user_id': 'user-1'},
    )

    invocation = runtime.execution_service.invocations[0]
    assert invocation['task'] == '修改后的任务'
    assert invocation['session_id'] == 'session-1'
    assert invocation['persist_user_message'] is False
    assert invocation['persist_final_answer'] is False
    assert session_app.assistant_messages[0]['content'] == '重试答案'
    assert result['answer'] == '重试答案'


def test_rollback_and_retry_still_requires_user_anchor():
    runtime = _FakeRuntimeService()
    session_app = _FakeSessionApplication()
    session_app.prepare_retry_error = ValueError('指定位置必须是用户消息（user），才能从此处重试')
    app = AgentCollaborationApplication(
        checkpoint_manager=_FakeCheckpointManager(),
        runtime_service=runtime,
        session_application=session_app,
    )

    with pytest.raises(ValueError, match='指定位置必须是用户消息'):
        app.rollback_and_retry(
            'session-1',
            {'after_seq': 3, 'modify_user_message': '修改后的任务', 'user_id': 'user-1'},
        )

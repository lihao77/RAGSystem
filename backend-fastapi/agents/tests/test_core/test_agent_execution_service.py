# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.core.models import AgentResponse
from services.agent_execution_service import AgentExecutionService


class _FakeAgent:
    def __init__(self, name='demo_agent'):
        self.name = name
        self.calls = []

    def execute(self, task, context):
        self.calls.append({'task': task, 'context': context})
        return AgentResponse(
            success=True,
            content='ok',
            agent_name=self.name,
            execution_time=0.1,
            metadata={'from_agent': True},
        )


class _FakeStore:
    def __init__(self):
        self.runs = []
        self.messages = []
        self.updated_run_steps = []
        self.child_agent = {
            'child_agent_id': 'child-1',
            'session_id': 'session-1',
            'agent_name': 'demo_agent',
            'thread_key': 'child:child-1',
            'status': 'active',
        }

    def get_child_agent(self, *, session_id, child_agent_id):
        if session_id == 'session-1' and child_agent_id == 'child-1':
            return dict(self.child_agent)
        return None

    def create_run(self, **kwargs):
        self.runs.append(kwargs)

    def update_child_agent_last_run(self, **kwargs):
        self.child_agent['last_run_id'] = kwargs['last_run_id']
        return True

    def add_message(self, **kwargs):
        self.messages.append(kwargs)
        return {'id': f"msg-{len(self.messages)}", 'seq': len(self.messages)}

    def update_run_steps_message_id(self, session_id, run_id, message_id):
        self.updated_run_steps.append((session_id, run_id, message_id))


class _FakeRuntime:
    def __init__(self):
        self.store = _FakeStore()
        self.agent = _FakeAgent()

    def get_conversation_store(self):
        return self.store

    def create_execution_orchestrator(self, session_id=None):
        del session_id
        return SimpleNamespace(agents={'demo_agent': self.agent})

    def build_context(
        self,
        *,
        session_id,
        user_id=None,
        limit=200,
        run_id=None,
        request_id=None,
        llm_override=None,
        thread_key='root',
        parent_run_id=None,
        parent_call_id=None,
        call_id=None,
    ):
        del session_id, limit, parent_run_id
        return SimpleNamespace(
            metadata={
                'run_id': run_id,
                'request_id': request_id,
                'llm_override': llm_override,
                'thread_key': thread_key,
                'parent_call_id': parent_call_id,
                'call_id': call_id,
            },
            user_id=user_id,
            llm_override=llm_override,
        )


def test_invoke_agent_root_persists_visible_messages():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    result = service.invoke_agent(
        mode='root',
        agent_name='demo_agent',
        task='hello',
        session_id='session-1',
        persist_user_message=True,
        persist_final_answer=True,
        visible_to_user=True,
    )

    assert result.thread_key == 'root'
    assert result.child_agent_id is None
    assert runtime.store.runs[0]['thread_key'] == 'root'
    assert runtime.store.messages[0]['role'] == 'user'
    assert runtime.store.messages[0]['metadata']['conversation_scope'] == 'root'
    assert runtime.store.messages[1]['role'] == 'assistant'
    assert runtime.store.messages[1]['metadata']['visible_to_user'] is True


def test_invoke_agent_child_uses_child_thread_and_hidden_messages():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    result = service.invoke_agent(
        mode='child',
        agent_name='demo_agent',
        task='continue',
        session_id='session-1',
        child_agent_id='child-1',
        persist_user_message=True,
        persist_final_answer=True,
        visible_to_user=False,
    )

    assert result.thread_key == 'child:child-1'
    assert result.child_agent_id == 'child-1'
    assert runtime.store.runs[0]['thread_key'] == 'child:child-1'
    assert runtime.store.runs[0]['child_agent_id'] == 'child-1'
    assert runtime.store.messages[0]['thread_key'] == 'child:child-1'
    assert runtime.store.messages[0]['metadata']['conversation_scope'] == 'child'
    assert runtime.store.messages[0]['metadata']['visible_to_user'] is False
    assert runtime.store.messages[1]['child_agent_id'] == 'child-1'
    assert runtime.store.updated_run_steps[0][1] == result.run_id

# -*- coding: utf-8 -*-

from pathlib import Path
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


class _FakeOrchestrator:
    def __init__(self, agent, fallback_agent=None):
        self.agent = agent
        self.fallback_agent = fallback_agent or agent
        self.route_calls = []
        self.agents = {
            agent.name: agent,
            self.fallback_agent.name: self.fallback_agent,
        }

    def route_task(self, task, context=None, preferred_agent=None):
        self.route_calls.append({
            'task': task,
            'context': context,
            'preferred_agent': preferred_agent,
        })
        if preferred_agent == 'missing_agent':
            return None
        if preferred_agent == 'fallback_agent':
            return self.fallback_agent
        return self.agent


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
        return {
            'id': f"msg-{len(self.messages)}",
            'seq': len(self.messages),
            'metadata': kwargs.get('metadata', {}),
            'role': kwargs.get('role'),
            'content': kwargs.get('content'),
            'thread_key': kwargs.get('thread_key'),
            'child_agent_id': kwargs.get('child_agent_id'),
        }

    def update_run_steps_message_id(self, session_id, run_id, message_id):
        self.updated_run_steps.append((session_id, run_id, message_id))

    def get_recent_messages(self, session_id, limit=20, thread_key=None):
        del session_id, limit, thread_key
        return []


class _FakeRuntime:
    def __init__(self):
        self.store = _FakeStore()
        self.agent = _FakeAgent()
        self.fallback_agent = _FakeAgent(name='fallback_agent')
        self.orchestrator = _FakeOrchestrator(self.agent, self.fallback_agent)
        self.workspace_root = None

    def get_conversation_store(self):
        return self.store

    def _get_session_workspace_root(self, session_id):
        del session_id
        return self.workspace_root

    def create_execution_orchestrator(self, session_id=None):
        del session_id
        return self.orchestrator

    def build_context(
        self,
        *,
        session_id,
        user_id=None,
        limit=200,
        run_id=None,
        request_id=None,
        llm_override=None,
        llm_tier=None,
        thread_key='root',
        parent_run_id=None,
        parent_call_id=None,
        call_id=None,
        agent_name=None,
    ):
        del session_id, limit, parent_run_id, agent_name
        return SimpleNamespace(
            metadata={
                'run_id': run_id,
                'request_id': request_id,
                'llm_override': llm_override,
                'requested_llm_tier': llm_tier,
                'thread_key': thread_key,
                'parent_call_id': parent_call_id,
                'call_id': call_id,
            },
            user_id=user_id,
            llm_override=llm_override,
            requested_llm_tier=llm_tier,
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


def test_invoke_routed_agent_uses_preferred_agent_route():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    result = service.invoke_routed_agent(
        task='hello',
        session_id='session-1',
        preferred_agent='fallback_agent',
        persist_user_message=True,
        persist_final_answer=True,
        visible_to_user=True,
    )

    assert runtime.orchestrator.route_calls[0]['preferred_agent'] == 'fallback_agent'
    assert result.response.agent_name == 'fallback_agent'
    assert runtime.store.messages[0]['metadata']['agent'] == 'fallback_agent'
    assert runtime.store.messages[1]['metadata']['agent'] == 'fallback_agent'


def test_invoke_routed_agent_uses_default_entry_when_no_preferred_agent():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    result = service.invoke_routed_agent(
        task='hello',
        session_id='session-1',
        preferred_agent=None,
        persist_user_message=True,
        persist_final_answer=True,
        visible_to_user=True,
    )

    assert runtime.orchestrator.route_calls[0]['preferred_agent'] is None
    assert result.response.agent_name == 'demo_agent'
    assert runtime.store.messages[0]['metadata']['agent'] == 'demo_agent'
    assert runtime.store.messages[1]['metadata']['agent'] == 'demo_agent'


def test_persist_user_message_creates_file_history_snapshot(tmp_path, monkeypatch):
    """用户消息提交时，如果有 pending tracked files 则创建 file history snapshot。"""
    import services.file_history as fh_mod
    monkeypatch.setattr(fh_mod, "FILE_HISTORY_ROOT", tmp_path / "file-history")
    fh_mod._instances.clear()

    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    runtime.workspace_root = str(workspace)

    # 模拟 agent 编辑了文件（在 persist_user_message 之前 track）
    from services.file_history import get_file_history
    fh = get_file_history('session-1')
    target_file = workspace / 'file.txt'
    fh.track_edit(str(target_file))
    target_file.write_text('hello')

    message = service.persist_user_message(
        session_id='session-1',
        task='hello',
        agent_name='demo_agent',
        mode='root',
        run_id='run-1',
        visible_to_user=True,
    )

    metadata = message['metadata']
    assert 'snapshot_id' in metadata
    assert metadata['snapshot_id'] is not None
    assert fh.has_snapshots()
    fh_mod._instances.clear()




def test_prepare_execution_propagates_llm_tier_to_context():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    handle = service.prepare_execution(
        agent_name='demo_agent',
        session_id='session-1',
        llm_tier='powerful',
    )

    assert handle.context.requested_llm_tier == 'powerful'
    assert handle.context.metadata['requested_llm_tier'] == 'powerful'


def test_prepare_execution_preserves_llm_override_identity_only_contract():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    handle = service.prepare_execution(
        agent_name='demo_agent',
        session_id='session-1',
        llm_override={
            'provider': 'demo',
            'provider_type': 'openai',
            'model_name': 'gpt-5.4',
            'thinking_budget_tokens': 4096,
        },
    )

    assert handle.context.llm_override['provider'] == 'demo'
    assert handle.context.llm_override['provider_type'] == 'openai'
    assert handle.context.llm_override['model_name'] == 'gpt-5.4'
    assert handle.context.llm_override['thinking_budget_tokens'] == 4096


def test_invoke_routed_agent_propagates_llm_tier_to_route_context():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    service.invoke_routed_agent(
        task='hello',
        session_id='session-1',
        llm_tier='fast',
        persist_user_message=True,
        persist_final_answer=True,
        visible_to_user=True,
    )

    assert runtime.orchestrator.route_calls[0]['context'].requested_llm_tier == 'fast'


def test_persist_user_message_uses_mode_scoped_metadata():
    runtime = _FakeRuntime()
    service = AgentExecutionService(runtime_service=runtime)

    root_message = service.persist_user_message(
        session_id='session-1',
        task='hello',
        agent_name='demo_agent',
        mode='root',
        run_id='run-root',
        visible_to_user=True,
    )
    child_message = service.persist_user_message(
        session_id='session-1',
        task='continue',
        agent_name='demo_agent',
        mode='child',
        run_id='run-child',
        child_agent_id='child-1',
        thread_key='child:child-1',
        visible_to_user=False,
    )

    assert root_message['id'] == 'msg-1'
    assert child_message['id'] == 'msg-2'
    assert runtime.store.messages[0]['metadata']['conversation_scope'] == 'root'
    assert runtime.store.messages[0]['metadata']['run_id'] == 'run-root'
    assert runtime.store.messages[1]['metadata']['conversation_scope'] == 'child'
    assert runtime.store.messages[1]['thread_key'] == 'child:child-1'
    assert runtime.store.messages[1]['metadata']['visible_to_user'] is False

# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.events.bus import EventType
from tools.local.agent_tools import call_agent, list_child_agents, send_message
from tools.runtime.response_builder import success_result


class _FakeEventBus:
    def __init__(self):
        self.published = []

    def publish(self, event):
        self.published.append(event)


class _FakeConfigManager:
    def __init__(self):
        self._config = SimpleNamespace(enabled=True, display_name='Demo Agent')

    def get_config(self, agent_name):
        assert agent_name == 'demo_agent'
        return self._config


class _FakeStore:
    def __init__(self):
        self.created_children = []
        self.messages = []
        self.child = {
            'child_agent_id': 'child-existing',
            'session_id': 'session-1',
            'agent_name': 'demo_agent',
            'thread_key': 'child:child-existing',
            'status': 'active',
        }

    def create_child_agent(self, **kwargs):
        self.created_children.append(kwargs)
        return kwargs

    def get_child_agent(self, *, session_id, child_agent_id):
        if session_id == 'session-1' and child_agent_id == 'child-existing':
            return dict(self.child)
        return None

    def list_child_agents(self, *, session_id, agent_name=None, limit=100):
        del limit
        items = [dict(self.child)]
        if agent_name is not None:
            items = [item for item in items if item.get('agent_name') == agent_name]
        return {'items': items, 'total': len(items)}

    def add_message(self, **kwargs):
        self.messages.append(kwargs)
        return {'id': 'msg-1', 'seq': 42}

    def get_recent_messages(self, *, session_id, limit=20, thread_key=None):
        assert session_id == 'session-1'
        assert thread_key == 'root'
        assert limit == 1
        return [{'id': 'msg-root-1', 'seq': 42}]


class _FakeRuntime:
    def __init__(self):
        self.execution_calls = []
        self.store = _FakeStore()

    def get_config_manager(self):
        return _FakeConfigManager()

    def get_conversation_store(self):
        return self.store

    def get_agent_execution_service(self):
        return self

    def create_execution_orchestrator(self, session_id=None):
        del session_id
        target = SimpleNamespace(
            agent_config=SimpleNamespace(enabled=True),
            display_name='Demo Agent',
        )
        return SimpleNamespace(agents={'demo_agent': target})

    def execute_agent_call(self, **kwargs):
        self.execution_calls.append(kwargs)
        return success_result(
            content={'answer': 'ok'},
            summary='ok',
            output_type='json',
            metadata={'run_id': 'child-run-1', 'child_agent_id': kwargs.get('child_agent_id')},
            tool_name='demo_agent',
        )


def test_call_agent_creates_child_agent_and_returns_child_agent_id(monkeypatch):
    runtime = _FakeRuntime()
    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_agent_api_runtime_service',
        lambda: runtime,
    )

    result = call_agent(
        agent_name='demo_agent',
        task='collect data',
        context_hint='focus on 2024',
        agent_config=SimpleNamespace(
            agent_name='orchestrator_agent',
            delegation=SimpleNamespace(enabled_agents=['demo_agent']),
        ),
        event_bus=None,
        session_id='session-1',
        run_id='run-1',
        cancel_event=None,
        parent_call_id='call-root',
    )

    assert result.success is True
    assert result.tool_name == 'call_agent'
    assert result.content == {'answer': 'ok'}
    assert result.metadata['agent_name'] == 'demo_agent'
    assert result.metadata['child_agent_id'].startswith('child_')
    assert runtime.store.created_children[0]['agent_name'] == 'demo_agent'
    assert runtime.store.created_children[0]['thread_key'] == f"child:{result.metadata['child_agent_id']}"
    assert runtime.store.created_children[0]['metadata']['created_via'] == 'call_agent'
    assert runtime.store.created_children[0]['metadata']['thread_key'] == f"child:{result.metadata['child_agent_id']}"
    assert runtime.store.created_children[0]['created_seq'] == 42
    assert runtime.store.messages == []
    assert runtime.execution_calls[0]['child_agent_id'] == result.metadata['child_agent_id']
    assert runtime.execution_calls[0]['parent_run_id'] == 'run-1'
    assert runtime.execution_calls[0]['call_id'] == result.metadata['agent_call_id']


def test_list_child_agents_returns_existing_children(monkeypatch):
    runtime = _FakeRuntime()
    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_agent_api_runtime_service',
        lambda: runtime,
    )

    result = list_child_agents(
        agent_name='demo_agent',
        limit=10,
        session_id='session-1',
    )

    assert result.success is True
    assert result.tool_name == 'list_child_agents'
    assert result.content['total'] == 1
    assert result.content['items'][0]['child_agent_id'] == 'child-existing'
    assert result.content['items'][0]['agent_name'] == 'demo_agent'


def test_call_agent_publishes_subtask_ordering_fields(monkeypatch):
    runtime = _FakeRuntime()
    bus = _FakeEventBus()
    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_agent_api_runtime_service',
        lambda: runtime,
    )

    call_agent(
        agent_name='demo_agent',
        task='collect data',
        agent_config=SimpleNamespace(
            agent_name='orchestrator_agent',
            delegation=SimpleNamespace(enabled_agents=['demo_agent']),
        ),
        event_bus=bus,
        session_id='session-1',
        run_id='run-1',
        parent_call_id='call-root',
        round=2,
        order=3,
        round_index=3,
    )

    start_event = next(event for event in bus.published if event.type == EventType.CALL_AGENT_START)
    end_event = next(event for event in bus.published if event.type == EventType.CALL_AGENT_END)

    assert start_event.data['round'] == 2
    assert start_event.data['order'] == 3
    assert start_event.data['round_index'] == 3
    assert start_event.data['mode'] == 'create'
    assert start_event.data['child_agent_id'].startswith('child_')
    assert end_event.data['order'] == 3
    assert end_event.data['round'] == 2
    assert end_event.data['round_index'] == 3
    assert end_event.data['mode'] == 'create'



def test_send_message_reuses_existing_child_agent(monkeypatch):
    runtime = _FakeRuntime()
    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_agent_api_runtime_service',
        lambda: runtime,
    )

    result = send_message(
        child_agent_id='child-existing',
        message='continue analysis',
        agent_config=SimpleNamespace(agent_name='orchestrator_agent'),
        event_bus=None,
        session_id='session-1',
        run_id='run-2',
        cancel_event=None,
        parent_call_id='call-root',
    )

    assert result.success is True
    assert result.tool_name == 'send_message'
    assert runtime.execution_calls[0]['call_id'].startswith('call_')

def test_send_message_publishes_resume_ordering_fields(monkeypatch):
    runtime = _FakeRuntime()
    bus = _FakeEventBus()
    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_agent_api_runtime_service',
        lambda: runtime,
    )

    send_message(
        child_agent_id='child-existing',
        message='continue analysis',
        agent_config=SimpleNamespace(agent_name='orchestrator_agent'),
        event_bus=bus,
        session_id='session-1',
        run_id='run-2',
        parent_call_id='call-root',
        round=4,
        order=2,
        round_index=2,
    )

    start_event = next(event for event in bus.published if event.type == EventType.CALL_AGENT_START)
    end_event = next(event for event in bus.published if event.type == EventType.CALL_AGENT_END)

    assert start_event.data['round'] == 4
    assert start_event.data['order'] == 2
    assert start_event.data['round_index'] == 2
    assert start_event.data['mode'] == 'resume'
    assert start_event.data['child_agent_id'] == 'child-existing'
    assert end_event.data['order'] == 2
    assert end_event.data['round'] == 4
    assert end_event.data['round_index'] == 2
    assert end_event.data['mode'] == 'resume'
    assert end_event.data['child_agent_id'] == 'child-existing'

# -*- coding: utf-8 -*-

from threading import Event as ThreadingEvent
from types import SimpleNamespace

from agents.core.models import AgentResponse
from agents.events.bus import EventType
from execution.adapters.agent_execution import AgentExecutionAdapter
from execution.persistence.message_handler import MessagePersistenceHandler


class _FakeEventBus:
    def __init__(self):
        self.subscriptions = []
        self.published = []

    def subscribe(self, event_types, handler, filter_func=None, priority=0):
        sub_id = f"sub-{len(self.subscriptions) + 1}"
        self.subscriptions.append({
            'id': sub_id,
            'event_types': event_types,
            'handler': handler,
            'filter_func': filter_func,
            'priority': priority,
        })
        return sub_id

    def unsubscribe(self, sub_id):
        self.subscriptions = [s for s in self.subscriptions if s['id'] != sub_id]

    def publish(self, event):
        self.published.append(event)
        for sub in list(self.subscriptions):
            if event.type not in sub['event_types']:
                continue
            if sub['filter_func'] and not sub['filter_func'](event):
                continue
            sub['handler'](event)


class _FakeStore:
    def __init__(self):
        self.messages = []
        self.updated = []

    def add_message(self, **kwargs):
        self.messages.append(kwargs)
        return {'id': f"msg-{len(self.messages)}", 'seq': len(self.messages)}

    def update_run_steps_message_id(self, session_id, run_id, message_id):
        self.updated.append((session_id, run_id, message_id))

    def get_recent_messages(self, session_id, limit=20, thread_key=None):
        del session_id, limit, thread_key
        return list(self.messages)


class _FakeRegistry:
    def __init__(self):
        self.finished = []
        self.cleaned = []

    def register_task(self, **kwargs):
        return 'task-1'

    def mark_running(self, task_id, thread=None):
        return None

    def set_task_persistent_subscriptions(self, task_id, subscription_ids, event_bus):
        return None

    def finish_task(self, task_id, status):
        self.finished.append((task_id, status))

    def cleanup_task_subscriptions(self, task_id):
        self.cleaned.append(task_id)


class _FakeAgentExecutionService:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def invoke_agent(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(response=self.response)


class _FakePreparedExecutionService(_FakeAgentExecutionService):
    def __init__(self, response):
        super().__init__(response)
        self.prepare_calls = []

    def persist_user_message(self, **kwargs):
        return {'id': 'msg-1', 'seq': 1}

    def prepare_execution(self, **kwargs):
        self.prepare_calls.append(kwargs)
        return SimpleNamespace(
            context=SimpleNamespace(
                user_id='user-1',
                llm_override=kwargs.get('llm_override'),
                requested_llm_tier=kwargs.get('llm_tier'),
                metadata={
                    'request_id': kwargs.get('request_id'),
                    'thread_key': 'root',
                    'conversation_scope': 'root',
                    'call_id': 'call-root',
                    'parent_call_id': None,
                    'cancel_event': kwargs.get('cancel_event'),
                    'requested_llm_tier': kwargs.get('llm_tier'),
                },
            ),
            agent=_FakeAgent(),
            run_id=kwargs.get('run_id', 'run-1'),
            thread_key='root',
            child_agent_id=None,
        )


class _FakeAgent:
    def __init__(self, name='orchestrator_agent'):
        self.name = name


def test_stream_adapter_passes_llm_tier_into_prepare_execution():
    response = AgentResponse(
        success=True,
        content='final content',
        agent_name='orchestrator_agent',
        execution_time=0.1,
    )
    service = _FakePreparedExecutionService(response)
    adapter = AgentExecutionAdapter(execution_service=SimpleNamespace(get_task_registry=lambda: _FakeRegistry(), get_session_manager=lambda: SimpleNamespace(get_or_create=lambda run_id, session_id=None: _FakeEventBus()), submit=lambda *args, **kwargs: SimpleNamespace(thread=None)), agent_execution_service=service)
    conversation_store = SimpleNamespace(
        get_session=lambda session_id: {'id': session_id},
        create_session=lambda **kwargs: kwargs,
    )
    orchestrator = SimpleNamespace(resolve_default_entry_agent=lambda: _FakeAgent())

    result = adapter.start_stream_execution(
        task='hello',
        session_id='session-1',
        user_id='user-1',
        llm_override={'provider': 'demo', 'provider_type': 'openai', 'model_name': 'gpt-5.4'},
        llm_tier='powerful',
        request_id='req-1',
        conversation_store=conversation_store,
        orchestrator=orchestrator,
        history_loader=lambda context, session_id, limit: None,
    )

    assert result.started is True
    assert service.prepare_calls[0]['llm_tier'] == 'powerful'


def test_stream_adapter_preserves_llm_override_passthrough():
    response = AgentResponse(
        success=True,
        content='final content',
        agent_name='orchestrator_agent',
        execution_time=0.1,
    )
    service = _FakePreparedExecutionService(response)
    adapter = AgentExecutionAdapter(execution_service=SimpleNamespace(get_task_registry=lambda: _FakeRegistry(), get_session_manager=lambda: SimpleNamespace(get_or_create=lambda run_id, session_id=None: _FakeEventBus()), submit=lambda *args, **kwargs: SimpleNamespace(thread=None)), agent_execution_service=service)
    conversation_store = SimpleNamespace(
        get_session=lambda session_id: {'id': session_id},
        create_session=lambda **kwargs: kwargs,
    )
    orchestrator = SimpleNamespace(resolve_default_entry_agent=lambda: _FakeAgent())

    adapter.start_stream_execution(
        task='hello',
        session_id='session-1',
        user_id='user-1',
        llm_override={'provider': 'demo', 'provider_type': 'openai', 'model_name': 'gpt-5.4', 'thinking_budget_tokens': 4096},
        llm_tier='powerful',
        request_id='req-1',
        conversation_store=conversation_store,
        orchestrator=orchestrator,
        history_loader=lambda context, session_id, limit: None,
    )

    assert service.prepare_calls[0]['llm_override']['thinking_budget_tokens'] == 4096


def test_stream_adapter_fallback_publishes_final_answer_event_instead_of_direct_write():
    event_bus = _FakeEventBus()
    store = _FakeStore()
    registry = _FakeRegistry()

    handler = MessagePersistenceHandler(
        event_bus=event_bus,
        store=store,
        session_id='session-1',
        run_id='run-1',
        cancel_event=ThreadingEvent(),
        entry_agent_name='orchestrator_agent',
        thread_key='root',
        conversation_scope='root',
        visible_to_user=True,
        child_agent_id=None,
    )
    handler.subscribe_all()
    event_bus.publish(SimpleNamespace(
        type=EventType.AGENT_START,
        session_id='session-1',
        agent_name='orchestrator_agent',
        call_id='call-root',
        parent_call_id=None,
        data={},
    ))

    user_message = store.add_message(
        session_id='session-1',
        role='user',
        content='hello',
        metadata={},
        thread_key='root',
        child_agent_id=None,
    )

    response = AgentResponse(
        success=True,
        content='final content',
        agent_name='orchestrator_agent',
        execution_time=0.1,
    )
    service = _FakeAgentExecutionService(response)
    execution_handle = SimpleNamespace(
        context=SimpleNamespace(
            user_id='user-1',
            llm_override=None,
            metadata={
                'request_id': 'req-1',
                'thread_key': 'root',
                'conversation_scope': 'root',
                'call_id': 'call-root',
                'parent_call_id': None,
                'cancel_event': ThreadingEvent(),
            },
        ),
        agent=_FakeAgent(),
        run_id='run-1',
        thread_key='root',
        child_agent_id=None,
    )

    target = AgentExecutionAdapter._create_agent_task_target(
        task_id='task-1',
        event_bus=event_bus,
        final_answer_saved=handler.final_answer_saved,
        agent_execution_service=service,
        execution_handle=execution_handle,
        registry=registry,
        run_id='run-1',
        session_id='session-1',
        store=store,
        task='hello',
        user_message=user_message,
    )

    result = target(None)

    assistant_messages = [m for m in store.messages if m['role'] == 'assistant']
    final_events = [e for e in event_bus.published if e.type == EventType.FINAL_ANSWER]
    message_saved_events = [e for e in event_bus.published if e.type == EventType.MESSAGE_SAVED]

    assert result.content == 'final content'
    assert len(assistant_messages) == 1
    assert assistant_messages[0]['content'] == 'final content'
    assert len(final_events) == 1
    assert len(message_saved_events) >= 2
    assert store.updated == [('session-1', 'run-1', 'msg-2')]
    assert registry.finished == [('task-1', 'completed')]

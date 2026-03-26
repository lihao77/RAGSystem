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


class _FakeRegistry:
    def __init__(self):
        self.finished = []
        self.cleaned = []

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


class _FakeAgent:
    def __init__(self, name='orchestrator_agent'):
        self.name = name


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

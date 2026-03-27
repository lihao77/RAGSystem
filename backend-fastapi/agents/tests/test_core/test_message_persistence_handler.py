# -*- coding: utf-8 -*-

from threading import Event as ThreadingEvent
from types import SimpleNamespace

from agents.events.bus import EventType
from execution.persistence.message_handler import MessagePersistenceHandler


class _FakeEventBus:
    def __init__(self):
        self.subscriptions = []
        self.published = []

    def subscribe(self, event_types, handler, filter_func=None, priority=0):
        sub_id = f"sub-{len(self.subscriptions)+1}"
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
        self.recent_messages = []

    def add_message(self, **kwargs):
        self.messages.append(kwargs)
        return {'id': f"msg-{len(self.messages)}", 'seq': len(self.messages)}

    def update_run_steps_message_id(self, session_id, run_id, message_id):
        self.updated.append((session_id, run_id, message_id))

    def get_recent_messages(self, session_id, limit=20, thread_key=None):
        del session_id, limit, thread_key
        return list(self.recent_messages)

    def insert_compression_message(self, **kwargs):
        return kwargs


def _event(event_type, *, session_id='session-1', agent_name='orchestrator_agent', call_id=None, parent_call_id=None, data=None):
    return SimpleNamespace(
        type=event_type,
        session_id=session_id,
        agent_name=agent_name,
        call_id=call_id,
        parent_call_id=parent_call_id,
        data=data or {},
    )


def test_message_handler_persists_only_entry_call_messages():
    bus = _FakeEventBus()
    store = _FakeStore()
    handler = MessagePersistenceHandler(
        event_bus=bus,
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

    bus.publish(_event(
        EventType.AGENT_START,
        call_id='call-root',
        parent_call_id=None,
    ))
    bus.publish(_event(
        EventType.REACT_INTERMEDIATE,
        call_id='call-root',
        data={'role': 'assistant', 'content': 'root intent', 'msg_type': 'intent', 'round': 1},
    ))
    bus.publish(_event(
        EventType.REACT_INTERMEDIATE,
        call_id='call-child',
        parent_call_id='call-root',
        agent_name='demo_agent',
        data={'role': 'assistant', 'content': 'child intent', 'msg_type': 'intent', 'round': 1},
    ))

    assert len(store.messages) == 1
    assert store.messages[0]['content'] == 'root intent'


def test_message_handler_normalizes_intermediate_msg_type():
    bus = _FakeEventBus()
    store = _FakeStore()
    handler = MessagePersistenceHandler(
        event_bus=bus,
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

    bus.publish(_event(EventType.AGENT_START, call_id='call-root', parent_call_id=None))
    bus.publish(_event(
        EventType.REACT_INTERMEDIATE,
        call_id='call-root',
        data={'role': 'assistant', 'content': 'thinking', 'msg_type': 'intent', 'round': 1},
    ))
    bus.publish(_event(
        EventType.REACT_INTERMEDIATE,
        call_id='call-root',
        data={'role': 'user', 'content': 'tool done', 'msg_type': 'unexpected_type', 'round': 1},
    ))



def test_message_handler_final_answer_uses_entry_call_boundary():
    bus = _FakeEventBus()
    store = _FakeStore()
    handler = MessagePersistenceHandler(
        event_bus=bus,
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

    bus.publish(_event(EventType.AGENT_START, call_id='call-root', parent_call_id=None))
    bus.publish(_event(EventType.FINAL_ANSWER, call_id='call-child', agent_name='demo_agent', data={'content': 'child final'}))
    bus.publish(_event(EventType.FINAL_ANSWER, call_id='call-root', agent_name='orchestrator_agent', data={'content': 'root final'}))

    assert len(store.messages) == 1
    assert store.messages[0]['content'] == 'root final'
    assert store.updated[0] == ('session-1', 'run-1', 'msg-1')


def test_message_handler_persists_session_memory_after_root_final_answer(monkeypatch):
    bus = _FakeEventBus()
    store = _FakeStore()
    store.recent_messages = [
        {'role': 'user', 'content': '后续请用中文，优先最少代码，不要兼容层'},
    ]
    saved_calls = []

    def _fake_save_memory(self, **kwargs):
        saved_calls.append(kwargs)
        return None

    monkeypatch.setattr('execution.persistence.message_handler.MemoryStore.save_memory', _fake_save_memory)

    handler = MessagePersistenceHandler(
        event_bus=bus,
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

    bus.publish(_event(EventType.AGENT_START, call_id='call-root', parent_call_id=None))
    bus.publish(_event(EventType.FINAL_ANSWER, call_id='call-root', agent_name='orchestrator_agent', data={'content': '好的，后续我会用中文并优先最少代码。'}))

    assert any(call['scope'] == 'session' for call in saved_calls)


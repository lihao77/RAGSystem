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
        self.compression_messages = []
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
        self.compression_messages.append(kwargs)
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


def test_message_handler_persists_compression_summary_to_event_thread():
    bus = _FakeEventBus()
    store = _FakeStore()
    handler = MessagePersistenceHandler(
        event_bus=bus,
        store=store,
        session_id='session-1',
        run_id='run-root',
        cancel_event=ThreadingEvent(),
        entry_agent_name='child_agent',
        thread_key='root',
        conversation_scope='root',
        visible_to_user=True,
        child_agent_id=None,
    )
    handler.subscribe_all()

    bus.publish(_event(
        EventType.COMPRESSION_SUMMARY,
        agent_name='child_agent',
        call_id='call-child',
        data={
            'content': '[历史摘要]\nchild summary',
            'session_id': 'session-1',
            'replaces_up_to_seq': 12,
            'thread_key': 'child:child-1',
            'child_agent_id': 'child-1',
            'conversation_scope': 'child',
            'visible_to_user': False,
            'run_id': 'run-child',
        },
    ))

    assert len(store.compression_messages) == 1
    saved = store.compression_messages[0]
    assert saved['thread_key'] == 'child:child-1'
    assert saved['child_agent_id'] == 'child-1'
    assert saved['replaces_up_to_seq'] == 12
    assert saved['metadata']['thread_key'] == 'child:child-1'
    assert saved['metadata']['conversation_scope'] == 'child'
    assert saved['metadata']['visible_to_user'] is False
    assert saved['metadata']['child_agent_id'] == 'child-1'
    assert saved['metadata']['run_id'] == 'run-child'



def test_message_handler_merges_final_answer_metadata_without_overriding_system_fields():
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
        EventType.FINAL_ANSWER,
        call_id='call-root',
        agent_name='orchestrator_agent',
        data={
            'content': 'root final',
            'metadata': {
                'execution_time': 1.23,
                'first_token_time': 0.45,
                'custom_field': 'kept',
                'run_id': 'other-run',
                'thread_key': 'other-thread',
            },
        },
    ))

    metadata = store.messages[0]['metadata']
    assert metadata['execution_time'] == 1.23
    assert metadata['first_token_time'] == 0.45
    assert metadata['custom_field'] == 'kept'
    assert metadata['run_id'] == 'run-1'
    assert metadata['thread_key'] == 'root'
    assert metadata['conversation_scope'] == 'root'
    assert metadata['visible_to_user'] is True


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

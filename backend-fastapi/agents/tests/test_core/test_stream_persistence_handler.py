# -*- coding: utf-8 -*-

from threading import Event as ThreadingEvent

from agents.events.bus import Event, EventBus, EventType
from execution.persistence.stream_handler import StreamPersistenceHandler


class _FakeStore:
    def __init__(self):
        self.messages = []
        self.run_steps = []
        self.run_updates = []
        self.step_resource_links = []

    def add_message(self, **kwargs):
        self.messages.append(kwargs)
        return {"id": "msg-1", "seq": 1}

    def add_run_step(self, **kwargs):
        self.run_steps.append(kwargs)
        return {
            "id": len(self.run_steps),
            "run_id": kwargs["run_id"],
            "step_order": len(self.run_steps),
        }

    def update_run_steps_message_id(self, session_id: str, run_id: str, message_id: str):
        return 0

    def update_run_status(self, run_id: str, **kwargs):
        self.run_updates.append({"run_id": run_id, **kwargs})
        return {"run_id": run_id, **kwargs}

    def attach_resource_to_step(self, **kwargs):
        self.step_resource_links.append(kwargs)
        return kwargs


def test_react_intermediate_is_persisted_as_message_and_run_step():
    bus = EventBus()
    store = _FakeStore()
    handler = StreamPersistenceHandler(
        event_bus=bus,
        store=store,
        session_id="session-1",
        run_id="run-1",
        cancel_event=ThreadingEvent(),
        entry_agent_name="orchestrator_agent",
        thread_key="child:child-1",
        conversation_scope="child",
        visible_to_user=False,
        child_agent_id="child-1",
    )
    handler.subscribe_all()

    bus.publish(Event(
        type=EventType.REACT_INTERMEDIATE,
        data={
            "role": "assistant",
            "msg_type": "thought",
            "round": 1,
            "content": "先搜索资料",
            "thought": "先搜索资料",
            "actions": [{"tool": "search", "arguments": {"q": "flood"}}],
        },
        session_id="session-1",
        agent_name="orchestrator_agent",
        call_id="call-root",
    ))

    assert len(store.messages) == 1
    assert store.messages[0]["metadata"]["react_intermediate"] is True
    assert store.messages[0]["metadata"]["thread_key"] == "child:child-1"
    assert store.messages[0]["metadata"]["child_agent_id"] == "child-1"
    assert store.messages[0]["metadata"]["visible_to_user"] is False
    assert store.messages[0]["thread_key"] == "child:child-1"
    assert store.messages[0]["content"] == "先搜索资料"
    assert len(store.run_steps) == 0


def test_run_end_updates_run_status():
    bus = EventBus()
    store = _FakeStore()
    handler = StreamPersistenceHandler(
        event_bus=bus,
        store=store,
        session_id="session-1",
        run_id="run-1",
        cancel_event=ThreadingEvent(),
        entry_agent_name="orchestrator_agent",
    )
    handler.subscribe_all()

    bus.publish(Event(
        type=EventType.EXECUTION_STEP,
        data={"kind": "run", "phase": "end", "run_id": "run-1", "status": "completed", "result_preview": "done"},
        session_id="session-1",
        agent_name="orchestrator_agent",
    ))

    assert store.run_updates
    assert store.run_updates[-1]["status"] == "completed"


def test_tool_end_attaches_resource_refs_to_step():
    bus = EventBus()
    store = _FakeStore()
    handler = StreamPersistenceHandler(
        event_bus=bus,
        store=store,
        session_id="session-1",
        run_id="run-1",
        cancel_event=ThreadingEvent(),
        entry_agent_name="orchestrator_agent",
    )
    handler.subscribe_all()

    bus.publish(Event(
        type=EventType.EXECUTION_STEP,
        data={
            "kind": "tool",
            "phase": "end",
            "call_id": "call-1",
            "tool_name": "write_file",
            "status": "success",
            "result_preview": "ok",
            "resource_refs": [{"resource_id": "res-1", "path": "/tmp/out.txt"}],
        },
        session_id="session-1",
        agent_name="orchestrator_agent",
    ))

    assert store.run_steps
    assert store.run_steps[-1]["step_type"] == EventType.EXECUTION_STEP.value
    assert store.step_resource_links == [{
        "session_id": "session-1",
        "run_id": "run-1",
        "step_id": 1,
        "resource_id": "res-1",
    }]

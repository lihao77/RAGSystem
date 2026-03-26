# -*- coding: utf-8 -*-

from threading import Event as ThreadingEvent

from agents.events.bus import Event, EventBus, EventType
from agents.events.publisher import EventPublisher
from execution.persistence.stream_handler import StreamPersistenceHandler


class _FakePublisher:
    def __init__(self, session_id: str = "session-1"):
        self.session_id = session_id
        self.events = []

    def tool_call_start(self, **kwargs):
        self.events.append(("tool_start", kwargs))

    def tool_call_end(self, **kwargs):
        self.events.append(("tool_end", kwargs))

    def react_intermediate(self, **kwargs):
        self.events.append(("react_intermediate", kwargs))


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


def test_intent_delta_execution_step_is_not_persisted():
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
            "kind": "intent",
            "phase": "delta",
            "call_id": "call-root",
            "step_id": "call-root:round:1",
            "content": "先搜索",
            "round": 1,
            "status": "running",
        },
        session_id="session-1",
        agent_name="orchestrator_agent",
    ))

    assert store.run_steps == []
    assert store.run_updates == []
    assert store.step_resource_links == []



def test_base_agent_tool_events_publish_round_via_publisher_only():
    import tools.runtime.executor as executor_module
    from agents.core.base import BaseAgent
    from tools.runtime.response_builder import success_result

    class _DummyAgent(BaseAgent):
        def execute(self, task, context):
            raise NotImplementedError

        def can_handle(self, task, context=None):
            return True

    agent = _DummyAgent(name="dummy_agent", description="dummy")
    agent.result_normalizer = object()
    agent.observation_policy = object()
    agent.prompt_materializer = object()
    agent._format_tool_observation = lambda *args, **kwargs: "ok"
    publisher = _FakePublisher()

    state = {
        "event_bus": None,
        "publisher": publisher,
        "call_id": "call-subtask",
        "current_session": [],
    }

    context = type("Ctx", (), {"session_id": "session-1", "metadata": {}})()

    original_execute_tool = executor_module.execute_tool
    executor_module.execute_tool = lambda *args, **kwargs: success_result("ok")
    try:
        agent._handle_actions(
            [{"tool": "demo_tool", "arguments": {"q": 1}}],
            context,
            state,
            3,
            "[dummy]",
        )
    finally:
        executor_module.execute_tool = original_execute_tool

    tool_events = [(name, payload) for name, payload in publisher.events if name in {"tool_start", "tool_end"}]
    assert [name for name, _ in tool_events] == ["tool_start", "tool_end"]
    assert tool_events[0][1]["round"] == 3
    assert tool_events[1][1]["round"] == 3
    assert tool_events[0][1]["parent_call_id"] == "call-subtask"
    assert tool_events[1][1]["parent_call_id"] == "call-subtask"



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
            "result": "ok-full",
            "result_preview": "ok",
            "raw_result": {"written": True},
            "raw_result_ref": {"call_id": "call-1"},
            "resource_refs": [{"resource_id": "res-1", "path": "/tmp/out.txt"}],
            "event_id": "evt-1",
            "timestamp": 123.4,
            "source_event_type": "call.tool.end",
        },
        session_id="session-1",
        agent_name="orchestrator_agent",
    ))

    assert store.run_steps
    persisted = store.run_steps[-1]["payload"]
    assert store.run_steps[-1]["step_type"] == EventType.EXECUTION_STEP.value
    assert persisted["result_preview"] == "ok"
    assert "result" not in persisted
    assert "raw_result_ref" not in persisted
    assert "resource_refs" not in persisted
    assert "event_id" not in persisted
    assert "timestamp" not in persisted
    assert "source_event_type" not in persisted
    assert store.step_resource_links == [{
        "session_id": "session-1",
        "run_id": "run-1",
        "step_id": 1,
        "resource_id": "res-1",
    }]

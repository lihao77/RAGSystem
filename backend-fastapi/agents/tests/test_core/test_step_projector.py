# -*- coding: utf-8 -*-

from agents.events.bus import Event, EventPriority, EventType
from execution.step_projector import StepProjector


class _FakeEventBus:
    def __init__(self):
        self.published = []

    def publish(self, event):
        self.published.append(event)


def _make_projector():
    return StepProjector(event_bus=_FakeEventBus(), session_id='session-1')


def test_project_run_start_to_execution_step():
    projector = _make_projector()
    event = Event(
        type=EventType.RUN_START,
        data={
            'run_id': 'run-1',
            'metadata': {
                'task': '分析任务',
                'agent_name': 'emergency_agent',
                'agent_display_name': '应急决策助手',
            },
        },
        session_id='session-1',
        agent_name='orchestrator_agent',
        call_id='call-root',
        priority=EventPriority.HIGH,
    )

    step = projector.project_event(event)

    assert step['kind'] == 'run'
    assert step['phase'] == 'start'
    assert step['run_id'] == 'run-1'
    assert step['call_id'] == 'call-root'
    assert step['description'] == '分析任务'
    assert step['status'] == 'running'
    assert step['agent_name'] == 'emergency_agent'
    assert step['agent_display_name'] == '应急决策助手'


def test_project_run_end_preserves_display_name():
    projector = _make_projector()
    event = Event(
        type=EventType.RUN_END,
        data={
            'run_id': 'run-1',
            'status': 'success',
            'summary': '完成',
            'metadata': {
                'agent_name': 'emergency_agent',
                'agent_display_name': '应急决策助手',
            },
        },
        session_id='session-1',
        agent_name='orchestrator_agent',
        call_id='call-root',
    )

    step = projector.project_event(event)

    assert step['kind'] == 'run'
    assert step['phase'] == 'end'
    assert step['agent_name'] == 'emergency_agent'
    assert step['agent_display_name'] == '应急决策助手'
    assert step['status'] == 'completed'


    projector = _make_projector()

    subtask_start = projector.project_event(Event(
        type=EventType.CALL_AGENT_START,
        data={
            'agent_name': 'kgqa_agent',
            'agent_display_name': '知识图谱代理',
            'description': '查询灾害数据',
            'child_agent_id': 'child-1',
            'mode': 'create',
            'round': 1,
            'round_index': 1,
            'order': 1,
            '_execution': {'run_id': 'run-1'},
        },
        session_id='session-1',
        agent_name='orchestrator_agent',
        call_id='call-subtask',
        parent_call_id='call-root',
    ))
    child_intent = projector.project_event(Event(
        type=EventType.INTENT_COMPLETE,
        data={
            'content': '开始分析',
            'round': 1,
            'agent_display_name': '知识图谱代理',
            '_execution': {'run_id': 'run-1'},
        },
        session_id='session-1',
        agent_name='kgqa_agent',
        call_id='call-subtask',
        parent_call_id='call-root',
    ))
    tool_end = projector.project_event(Event(
        type=EventType.CALL_TOOL_END,
        data={
            'tool_name': 'read_file',
            'agent_display_name': '知识图谱代理',
            'success': True,
            'result_preview': '读取成功',
            'raw_result': {'content': 'ok'},
            'raw_result_ref': {'call_id': 'tool-1'},
            'elapsed_time': 0.3,
            'resource_refs': [{'resource_id': 'res-1'}],
            'round': 1,
            '_execution': {'run_id': 'run-1'},
        },
        session_id='session-1',
        agent_name='kgqa_agent',
        call_id='tool-1',
        parent_call_id='call-subtask',
    ))

    assert subtask_start['kind'] == 'subtask'
    assert subtask_start['phase'] == 'start'
    assert subtask_start['agent_display_name'] == '知识图谱代理'
    assert subtask_start['child_agent_id'] == 'child-1'
    assert subtask_start['mode'] == 'create'
    assert subtask_start['round'] == 1
    assert subtask_start['parent_call_id'] == 'call-root'
    assert subtask_start['step_id'] == 'call-subtask:call'
    assert subtask_start['parent_step_id'] == 'call-root:round:1'

    assert child_intent['kind'] == 'intent'
    assert child_intent['phase'] == 'complete'
    assert child_intent['agent_display_name'] == '知识图谱代理'
    assert child_intent['step_id'] == 'call-subtask:round:1'
    assert child_intent['parent_step_id'] == 'call-subtask:call'

    assert tool_end['kind'] == 'tool'
    assert tool_end['phase'] == 'end'
    assert tool_end['agent_display_name'] == '知识图谱代理'
    assert tool_end['tool_name'] == 'read_file'
    assert tool_end['result_preview'] == '读取成功'
    assert tool_end['raw_result_available'] is True
    assert tool_end['resource_refs'] == [{'resource_id': 'res-1'}]
    assert tool_end['step_id'] == 'tool-1:tool'
    assert tool_end['parent_step_id'] == 'call-subtask:round:1'


def test_handle_event_republishes_execution_step():
    bus = _FakeEventBus()
    projector = StepProjector(event_bus=bus, session_id='session-1')
    event = Event(
        type=EventType.INTENT_COMPLETE,
        data={'content': '先搜索资料', 'round': 1, '_execution': {'task_id': 'task-1', 'run_id': 'run-1'}},
        session_id='session-1',
        agent_name='orchestrator_agent',
        call_id='call-root',
    )

    projector._handle_event(event)

    assert len(bus.published) == 1
    published = bus.published[0]
    assert published.type == EventType.EXECUTION_STEP
    assert published.data['kind'] == 'intent'
    assert published.data['phase'] == 'complete'
    assert published.data['step_id'] == 'call-root:round:1'
    assert published.data['parent_step_id'] == 'call-root:run'
    assert published.data['content'] == '先搜索资料'
    assert published.data['_execution']['task_id'] == 'task-1'
    assert published.data['_execution']['run_id'] == 'run-1'

# -*- coding: utf-8 -*-
from pathlib import Path

import pytest

from application.agent_session import AgentSessionApplication
from schemas.session import CreateSessionRequest


class _FakeConversationStore:
    def __init__(self):
        self.deleted_session_id = None
        self.created_sessions = []
        self.last_run_steps_call = None

    def list_messages(self, *, session_id: str, limit: int, offset: int):
        assert session_id == 'session-1'
        return {
            'items': [
                {
                    'seq': 1,
                    'id': 'msg-react-1',
                    'role': 'assistant',
                    'content': '<intent>第一轮思考</intent><tools><tool name="create_chart" /></tools>',
                    'metadata': {
                        'react_intermediate': True,
                        'msg_type': 'intent',
                        'round': 1,
                        'run_id': 'run-1',
                        'agent': 'orchestrator_agent',
                    },
                    'created_at': '2026-03-19T00:00:00Z',
                },
                {
                    'seq': 2,
                    'id': 'msg-react-2',
                    'role': 'user',
                    'content': '[create_chart]\n✅ 已生成图表',
                    'metadata': {
                        'react_intermediate': True,
                        'msg_type': 'observation',
                        'round': 1,
                        'run_id': 'run-1',
                        'agent': 'orchestrator_agent',
                    },
                    'created_at': '2026-03-19T00:00:01Z',
                },
                {
                    'seq': 2.5,
                    'id': 'msg-child-hidden',
                    'role': 'user',
                    'content': '请继续本会话，仅返回一句确认语',
                    'metadata': {
                        'run_id': 'run-child-1',
                        'agent': 'kgqa_agent',
                        'visible_to_user': False,
                        'conversation_scope': 'child',
                    },
                    'thread_key': 'child:child-1',
                    'created_at': '2026-03-19T00:00:01Z',
                },
                {
                    'id': 'msg-final',
                    'role': 'assistant',
                    'content': '最终答案',
                    'metadata': {
                        'run_id': 'run-1',
                        'agent': 'orchestrator_agent',
                    },
                    'created_at': '2026-03-19T00:00:02Z',
                },
            ],
            'total': 3,
            'limit': limit,
            'offset': offset,
            'has_more': False,
        }

    def list_run_steps(self, *, run_id: str = None, message_id: str = None, session_id: str, limit: int):
        self.last_run_steps_call = {
            'run_id': run_id,
            'message_id': message_id,
            'session_id': session_id,
            'limit': limit,
        }
        assert session_id == 'session-1'
        return []

    def get_session(self, session_id: str):
        if session_id == 'session-delete':
            return {'session_id': session_id}
        return None

    def create_session(self, *, session_id: str, user_id=None, metadata=None):
        self.created_sessions.append({
            'session_id': session_id,
            'user_id': user_id,
            'metadata': metadata or {},
        })

    def delete_session(self, *, session_id: str):
        self.deleted_session_id = session_id
        return True


class _FakeConversationStoreWithSteps(_FakeConversationStore):
    def list_runs(self, session_id: str, limit: int = 50):
        assert session_id == 'session-1'
        return {'items': [], 'total': 0}

    def list_run_steps(self, *, run_id: str = None, message_id: str = None, session_id: str, limit: int):
        self.last_run_steps_call = {
            'run_id': run_id,
            'message_id': message_id,
            'session_id': session_id,
            'limit': limit,
        }
        assert session_id == 'session-1'
        assert run_id == 'run-1' or message_id == 'msg-final'
        return [
            {
                'step_order': 1,
                'step_type': 'execution.step',
                'payload': {
                    'kind': 'run',
                    'phase': 'start',
                    'call_id': 'call-root',
                    'node_id': 'call-root',
                    'parent_node_id': None,
                    'source_event_type': 'run.start',
                    'timestamp': 123.4,
                    'event_id': 'evt-run-start',
                    'run_id': 'run-1',
                    'description': '顶层编排',
                    'status': 'running',
                },
            },
            {
                'step_order': 2,
                'step_type': 'execution.step',
                'payload': {
                    'kind': 'subtask',
                    'phase': 'start',
                    'call_id': 'call-sub',
                    'parent_call_id': 'call-root',
                    'agent_name': 'kgqa_agent',
                    'agent_display_name': '知识图谱代理',
                    'description': '查询数据',
                    'round': 1,
                    'status': 'running',
                },
            },
            {
                'step_order': 3,
                'step_type': 'execution.step',
                'payload': {
                    'kind': 'intent',
                    'phase': 'complete',
                    'call_id': 'call-root',
                    'content': '先查数据',
                    'round': 1,
                    'status': 'completed',
                },
            },
        ]


def test_list_messages_filters_react_intermediate_messages():
    app = AgentSessionApplication(conversation_store=_FakeConversationStore())

    result = app.list_messages(session_id='session-1', limit=20, offset=0, expand_steps=False)

    assert len(result['items']) == 1
    assistant = result['items'][0]
    assert assistant['id'] == 'msg-final'
    assert assistant['has_execution'] is True
    assert 'react_trace' not in assistant


def test_list_messages_filters_child_internal_messages():
    app = AgentSessionApplication(conversation_store=_FakeConversationStore())

    result = app.list_messages(session_id='session-1', limit=20, offset=0, expand_steps=False)

    assert [item['id'] for item in result['items']] == ['msg-final']



def test_list_messages_returns_canonical_execution_steps():
    app = AgentSessionApplication(conversation_store=_FakeConversationStoreWithSteps())

    result = app.list_messages(session_id='session-1', limit=20, offset=0, expand_steps=True)

    assistant = result['items'][0]
    assert assistant['has_execution'] is True
    execution_steps = assistant['execution_steps']
    assert [step['kind'] for step in execution_steps] == ['run', 'subtask', 'intent']
    assert [step['phase'] for step in execution_steps] == ['start', 'start', 'complete']
    assert execution_steps[2]['content'] == '先查数据'
    assert 'node_id' not in execution_steps[0]
    assert 'parent_node_id' not in execution_steps[0]
    assert 'source_event_type' not in execution_steps[0]
    assert 'timestamp' not in execution_steps[0]
    assert 'event_id' not in execution_steps[0]


def test_list_message_run_steps_returns_paginated_execution_steps():
    store = _FakeConversationStoreWithSteps()
    app = AgentSessionApplication(conversation_store=store)

    result = app.list_message_run_steps(session_id='session-1', message_id='msg-final', limit=2, offset=1)

    assert [step['kind'] for step in result['items']] == ['subtask', 'intent']
    assert result['total'] == 3
    assert result['limit'] == 2
    assert result['offset'] == 1
    assert result['has_more'] is False
    assert store.last_run_steps_call == {
        'run_id': None,
        'message_id': 'msg-final',
        'session_id': 'session-1',
        'limit': 3,
    }


def test_delete_session_delegates_cleanup_to_conversation_store():
    store = _FakeConversationStore()
    app = AgentSessionApplication(conversation_store=store)

    result = app.delete_session('session-delete')

    assert result is True
    assert store.deleted_session_id == 'session-delete'


def test_create_session_persists_workspace_root_metadata():
    store = _FakeConversationStore()
    app = AgentSessionApplication(conversation_store=store)
    workspace_root = str(Path.cwd().resolve())

    result = app.create_session(
        session_id='session-workspace',
        user_id='user-1',
        metadata={'workspace_root': workspace_root},
    )

    assert result['metadata']['workspace_root'] == workspace_root
    assert store.created_sessions[0]['metadata']['workspace_root'] == workspace_root


def test_create_session_persists_entry_agent_metadata():
    store = _FakeConversationStore()
    app = AgentSessionApplication(conversation_store=store)

    result = app.create_session(
        session_id='session-entry-agent',
        user_id='user-1',
        metadata={'entry_agent': 'qa_agent'},
    )

    assert result['metadata']['entry_agent'] == 'qa_agent'
    assert store.created_sessions[0]['metadata']['entry_agent'] == 'qa_agent'


def test_create_session_persists_team_metadata():
    store = _FakeConversationStore()
    app = AgentSessionApplication(conversation_store=store)

    result = app.create_session(
        session_id='session-team',
        user_id='user-1',
        metadata={'team': 'team_b'},
    )

    assert result['metadata']['team'] == 'team_b'
    assert store.created_sessions[0]['metadata']['team'] == 'team_b'


def test_create_session_request_normalizes_blank_team():
    request = CreateSessionRequest(metadata={'team': '   '})
    assert request.metadata == {}


def test_create_session_request_rejects_non_string_team():
    with pytest.raises(ValueError):
        CreateSessionRequest(metadata={'team': 123})


def test_create_session_request_validates_workspace_root_as_absolute_path():
    workspace_root = str(Path.cwd().resolve())
    request = CreateSessionRequest(metadata={'workspace_root': workspace_root})
    assert request.metadata['workspace_root'] == workspace_root

    try:
        CreateSessionRequest(metadata={'workspace_root': 'relative/path'})
        assert False, 'expected validation error'
    except Exception as error:
        assert 'workspace_root' in str(error)


def test_create_session_request_validates_entry_agent():
    request = CreateSessionRequest(metadata={'entry_agent': 'qa_agent'})
    assert request.metadata['entry_agent'] == 'qa_agent'

    try:
        CreateSessionRequest(metadata={'entry_agent': '   '})
        assert False, 'expected validation error'
    except Exception as error:
        assert 'entry_agent' in str(error)

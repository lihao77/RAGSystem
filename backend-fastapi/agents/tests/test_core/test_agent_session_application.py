# -*- coding: utf-8 -*-
from pathlib import Path

from application.agent_session import AgentSessionApplication
from schemas.session import CreateSessionRequest


class _FakeConversationStore:
    def __init__(self):
        self.deleted_session_id = None
        self.created_sessions = []

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
                        'msg_type': 'assistant_response',
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

    def list_run_steps(self, *, run_id: str, session_id: str, limit: int):
        assert run_id == 'run-1'
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
    def list_run_steps(self, *, run_id: str, session_id: str, limit: int):
        assert run_id == 'run-1'
        assert session_id == 'session-1'
        return [
            {
                'step_order': 1,
                'step_type': 'execution.step',
                'payload': {
                    'kind': 'run',
                    'phase': 'start',
                    'call_id': 'call-root',
                    'node_id': 'call-root',
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

    result = app.list_messages(session_id='session-1', limit=20, offset=0, expand_steps=True)

    assert len(result['items']) == 1
    assistant = result['items'][0]
    assert assistant['id'] == 'msg-final'
    assert 'react_trace' not in assistant


def test_list_messages_filters_child_internal_messages():
    app = AgentSessionApplication(conversation_store=_FakeConversationStore())

    result = app.list_messages(session_id='session-1', limit=20, offset=0, expand_steps=False)

    assert [item['id'] for item in result['items']] == ['msg-final']



def test_list_messages_returns_canonical_execution_steps():
    app = AgentSessionApplication(conversation_store=_FakeConversationStoreWithSteps())

    result = app.list_messages(session_id='session-1', limit=20, offset=0, expand_steps=True)

    assistant = result['items'][0]
    execution_steps = assistant['execution_steps']
    assert [step['kind'] for step in execution_steps] == ['run', 'subtask', 'intent']
    assert [step['phase'] for step in execution_steps] == ['start', 'start', 'complete']
    assert execution_steps[2]['content'] == '先查数据'


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


def test_create_session_request_validates_workspace_root_as_absolute_path():
    workspace_root = str(Path.cwd().resolve())
    request = CreateSessionRequest(metadata={'workspace_root': workspace_root})
    assert request.metadata['workspace_root'] == workspace_root

    try:
        CreateSessionRequest(metadata={'workspace_root': 'relative/path'})
        assert False, 'expected validation error'
    except Exception as error:
        assert 'workspace_root' in str(error)

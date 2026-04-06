import threading
from unittest.mock import MagicMock

from tools.contracts.permission_modes import PermissionMode, PermissionPolicy
from tools.permission_manager import set_permission_policy
from tools.runtime.approvals import request_user_approval_if_needed
from tools.runtime.models import ToolUseContext


class _FakeApprovalRegistry:
    def __init__(self):
        self._events = {}
        self._results = {}

    def add_pending_approval(self, session_id, approval_id):
        event = threading.Event()
        self._events[(session_id, approval_id)] = event
        self._results[(session_id, approval_id)] = (False, '')
        return event

    def resolve_approval(self, session_id, approval_id, approved, message=''):
        self._results[(session_id, approval_id)] = (approved, message)
        self._events[(session_id, approval_id)].set()

    def get_approval_result(self, session_id, approval_id):
        return self._results[(session_id, approval_id)]


def test_user_approval_event_includes_permission_mode_and_reason(monkeypatch):
    from tools.contracts.permissions import RiskLevel, ToolPermission
    from tools.permissions import TOOL_PERMISSIONS

    registry = _FakeApprovalRegistry()
    published = {}

    monkeypatch.setattr('agents.task_registry.get_task_registry', lambda: registry)
    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD))

    # 注册测试工具权限
    TOOL_PERMISSIONS['execute_bash'] = ToolPermission(
        tool_name='execute_bash',
        risk_level=RiskLevel.HIGH,
        description='Execute bash command',
        allowed_callers=['direct'],
    )

    event_bus = MagicMock()

    def fake_publish(event):
        if getattr(event, 'type', None) != 'user.approval_required':
            return
        published['event'] = event

        def approve():
            registry.resolve_approval(event.session_id, event.data['approval_id'], True, '允许执行')

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    context = ToolUseContext(
        tool_name='execute_bash',
        arguments={'command': 'rm demo.txt'},
        event_bus=event_bus,
        session_id='session-approval-payload',
    )
    outcome = request_user_approval_if_needed(context)

    assert outcome.allowed is True
    assert outcome.error_result is None
    assert outcome.approval_message == '允许执行'

    event = published['event']
    assert event.data['tool_name'] == 'execute_bash'
    assert event.data['permission_mode'] == 'standard'
    assert event.data['approval_reason'] == '标准模式：high 风险工具需要审批'

    # 清理
    del TOOL_PERMISSIONS['execute_bash']

def test_user_approval_event_includes_external_paths_for_document_tools(monkeypatch):
    from tools.contracts.permissions import RiskLevel, ToolPermission
    from tools.permissions import TOOL_PERMISSIONS

    registry = _FakeApprovalRegistry()
    published = {}

    monkeypatch.setattr('agents.task_registry.get_task_registry', lambda: registry)
    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD))

    TOOL_PERMISSIONS['edit_file'] = ToolPermission(
        tool_name='edit_file',
        risk_level=RiskLevel.HIGH,
        description='Edit file',
        allowed_callers=['direct'],
    )

    event_bus = MagicMock()
    external_path = 'C:/tmp/outside.txt'

    def fake_publish(event):
        if getattr(event, 'type', None) != 'user.approval_required':
            return
        published['event'] = event

        def approve():
            registry.resolve_approval(event.session_id, event.data['approval_id'], True, '允许越界访问')

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    context = ToolUseContext(
        tool_name='edit_file',
        arguments={'file_path': external_path, 'old_string': 'a', 'new_string': 'b'},
        event_bus=event_bus,
        session_id='session-approval-external-path',
        caller='direct',
    )
    outcome = request_user_approval_if_needed(context)

    normalized_external_path = external_path.replace('/', '\\')
    assert outcome.allowed is True
    assert outcome.approved_external_paths == [normalized_external_path]
    assert outcome.approval_metadata['approved_external_paths'] == [normalized_external_path]
    assert published['event'].data['approved_external_paths'] == [normalized_external_path]
    assert published['event'].data['approval_reason'] == '路径越界访问需要审批'

    del TOOL_PERMISSIONS['edit_file']



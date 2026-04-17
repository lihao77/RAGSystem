import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tools.contracts.permission_modes import PermissionMode, PermissionPolicy
from tools.permission_manager import set_permission_policy
from tools.permissions import TOOL_PERMISSIONS
from tools.runtime.approvals import request_user_approval_if_needed
from tools.runtime.models import ToolUseContext


@pytest.fixture(autouse=True)
def _reset_tool_permissions():
    snapshot = dict(TOOL_PERMISSIONS)
    yield
    TOOL_PERMISSIONS.clear()
    TOOL_PERMISSIONS.update(snapshot)


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


def test_skip_all_approvals_short_circuits_runtime_approval(monkeypatch):
    from tools.contracts.permissions import RiskLevel, ToolPermission
    from tools.permissions import TOOL_PERMISSIONS

    published = {}
    event_bus = MagicMock()
    event_bus.publish = lambda event: published.setdefault('event', event)

    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD, skip_all_approvals=True))
    TOOL_PERMISSIONS['execute_bash'] = ToolPermission(
        tool_name='execute_bash',
        risk_level=RiskLevel.HIGH,
        description='Execute bash command',
        allowed_callers=['direct'],
    )

    context = ToolUseContext(
        tool_name='execute_bash',
        arguments={'command': 'rm demo.txt'},
        event_bus=event_bus,
        session_id='session-skip-all-runtime',
    )
    outcome = request_user_approval_if_needed(context)

    assert outcome.allowed is True
    assert published == {}

    del TOOL_PERMISSIONS['execute_bash']
    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD))


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
    assert event.data['approval_reason_codes'] == ['ask-risk']

    # 清理
    del TOOL_PERMISSIONS['execute_bash']

def test_skip_all_approvals_skips_path_approval(monkeypatch):
    from tools.contracts.permissions import RiskLevel, ToolPermission
    from tools.permissions import TOOL_PERMISSIONS

    published = {}
    event_bus = MagicMock()
    event_bus.publish = lambda event: published.setdefault('event', event)

    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD, skip_all_approvals=True))
    TOOL_PERMISSIONS['edit_file'] = ToolPermission(
        tool_name='edit_file',
        risk_level=RiskLevel.HIGH,
        description='Edit file',
        allowed_callers=['direct'],
    )

    context = ToolUseContext(
        tool_name='edit_file',
        arguments={'file_path': 'C:/tmp/outside.txt', 'old_string': 'a', 'new_string': 'b'},
        event_bus=event_bus,
        session_id='session-skip-all-path',
        caller='direct',
    )
    outcome = request_user_approval_if_needed(context)

    assert outcome.allowed is True
    assert outcome.approved_external_paths == ['C:\\tmp\\outside.txt']
    assert published == {}

    del TOOL_PERMISSIONS['edit_file']
    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD))


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
    assert outcome.approval_metadata['reason_codes'] == ['ask-risk', 'ask-path']
    assert outcome.approval_metadata['secondary_reasons'] == ['标准模式：high 风险工具需要审批']
    assert published['event'].data['approved_external_paths'] == [normalized_external_path]
    assert published['event'].data['approval_reason'] == '路径越界访问需要审批'
    assert published['event'].data['approval_reason_codes'] == ['ask-risk', 'ask-path']
    assert published['event'].data['approval_secondary_reasons'] == ['标准模式：high 风险工具需要审批']





def test_managed_absolute_read_path_does_not_trigger_path_approval(monkeypatch, tmp_path):
    from tools.contracts.permissions import RiskLevel, ToolPermission
    from tools.permissions import TOOL_PERMISSIONS

    registry = _FakeApprovalRegistry()
    published = {}

    monkeypatch.setattr('agents.task_registry.get_task_registry', lambda: registry)
    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD))

    TOOL_PERMISSIONS['read_file'] = ToolPermission(
        tool_name='read_file',
        risk_level=RiskLevel.LOW,
        description='Read file',
        allowed_callers=['direct'],
    )

    session_id = 'session-managed-absolute-read'
    transient_root = Path.home() / '.ragsystem' / 'sessions' / session_id / 'transient'
    managed_path = transient_root / 'data_c6414389.json'

    event_bus = MagicMock()
    event_bus.publish = lambda event: published.setdefault('event', event)

    context = ToolUseContext(
        tool_name='read_file',
        arguments={'file_path': str(managed_path)},
        event_bus=event_bus,
        session_id=session_id,
        caller='direct',
    )
    outcome = request_user_approval_if_needed(context)

    assert outcome.allowed is True
    assert outcome.approved_external_paths == []
    assert outcome.approval_reason_codes == []
    assert published == {}

    del TOOL_PERMISSIONS['read_file']


def test_external_absolute_read_path_triggers_path_approval(monkeypatch):
    from tools.contracts.permissions import RiskLevel, ToolPermission
    from tools.permissions import TOOL_PERMISSIONS

    registry = _FakeApprovalRegistry()
    published = {}

    monkeypatch.setattr('agents.task_registry.get_task_registry', lambda: registry)
    set_permission_policy(PermissionPolicy(mode=PermissionMode.STANDARD))

    TOOL_PERMISSIONS['read_file'] = ToolPermission(
        tool_name='read_file',
        risk_level=RiskLevel.LOW,
        description='Read file',
        allowed_callers=['direct'],
    )

    event_bus = MagicMock()
    external_path = 'C:/tmp/outside-read.json'

    def fake_publish(event):
        if getattr(event, 'type', None) != 'user.approval_required':
            return
        published['event'] = event

        def approve():
            registry.resolve_approval(event.session_id, event.data['approval_id'], True, '允许读取')

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    context = ToolUseContext(
        tool_name='read_file',
        arguments={'file_path': external_path},
        event_bus=event_bus,
        session_id='session-external-absolute-read',
        caller='direct',
    )
    outcome = request_user_approval_if_needed(context)

    normalized_external_path = str(Path(external_path.replace('/', '\\')).resolve())
    assert outcome.allowed is True
    assert outcome.approved_external_paths == [normalized_external_path]
    assert outcome.approval_reason_codes == ['ask-path']
    assert published['event'].data['approved_external_paths'] == [normalized_external_path]
    assert published['event'].data['approval_reason_codes'] == ['ask-path']

    del TOOL_PERMISSIONS['read_file']



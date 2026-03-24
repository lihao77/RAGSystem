import threading
from pathlib import Path
from unittest.mock import MagicMock

from tools.runtime.bootstrap import bootstrap_tool_system
from tools.local.code_sandbox import execute_code_sandbox
from tools.runtime.response_builder import success_result


bootstrap_tool_system()


def test_execute_code_call_tool_passes_session_id_for_approval(monkeypatch):
    captured = {}

    def _fake_execute_tool(*, tool_name, arguments, agent_config, event_bus, user_role, caller, session_id, cancel_event=None):
        captured["tool_name"] = tool_name
        captured["arguments"] = arguments
        captured["caller"] = caller
        captured["session_id"] = session_id
        captured["cancel_event"] = cancel_event is not None
        return success_result(
            content={"ok": True},
            summary="ok",
            output_type="json",
            tool_name=tool_name,
        )

    monkeypatch.setattr("tools.runtime.executor.execute_tool", _fake_execute_tool)

    result = execute_code_sandbox(
        code="result = call_tool('preview_data_structure', {'file_path': 'sample.json'})",
        description="approval session propagation",
        agent_config=None,
        event_bus=object(),
        user_role=None,
        session_id="session-approval-1",
    )

    assert result.success is True
    assert captured == {
        "tool_name": "preview_data_structure",
        "arguments": {"file_path": "sample.json"},
        "caller": "code_execution",
        "session_id": "session-approval-1",
        "cancel_event": False,
    }


class _FakeApprovalRegistry:
    def __init__(self):
        self._events = {}
        self._results = {}

    def add_pending_approval(self, session_id, approval_id):
        event = threading.Event()
        self._events[(session_id, approval_id)] = event
        self._results[(session_id, approval_id)] = (False, "")
        return event

    def resolve_approval(self, session_id, approval_id, approved, message=""):
        key = (session_id, approval_id)
        self._results[key] = (approved, message)
        self._events[key].set()

    def get_approval_result(self, session_id, approval_id):
        return self._results[(session_id, approval_id)]


def _crash_worker_for_test(conn, payload):
    del payload
    conn.close()
    raise SystemExit(0)


def test_execute_code_import_approval_allows_restricted_module(monkeypatch):
    registry = _FakeApprovalRegistry()
    published = {}

    monkeypatch.setattr("tools.local.code_sandbox.get_task_registry", lambda: registry)

    event_bus = MagicMock()

    def fake_publish(event):
        if getattr(event, "type", None) != "user.approval_required":
            return
        published["event"] = event

        def approve():
            registry.resolve_approval(
                event.session_id,
                event.data["approval_id"],
                True,
                "仅本次执行允许导入",
            )

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    result = execute_code_sandbox(
        code="from pathlib import Path\nresult = Path('demo.txt').name",
        description="restricted import approval",
        agent_config=None,
        event_bus=event_bus,
        user_role=None,
        session_id="session-import-allow",
    )

    assert result.success is True
    assert result.content == "demo.txt"
    assert published["event"].data["tool_name"] == "sandbox_module_import"
    assert published["event"].data["arguments"]["module_name"] == "pathlib"
    assert "from pathlib import Path" in published["event"].data["arguments"]["code_snippet"]


def test_execute_code_import_approval_denied_returns_error(monkeypatch):
    registry = _FakeApprovalRegistry()
    published = {}

    monkeypatch.setattr("tools.local.code_sandbox.get_task_registry", lambda: registry)

    event_bus = MagicMock()

    def fake_publish(event):
        if getattr(event, "type", None) != "user.approval_required":
            return
        published["event"] = event

        def deny():
            registry.resolve_approval(
                event.session_id,
                event.data["approval_id"],
                False,
                "生产环境暂不允许该包",
            )

        threading.Thread(target=deny).start()

    event_bus.publish = fake_publish

    result = execute_code_sandbox(
        code="from pathlib import Path\nresult = Path('demo.txt').name",
        description="restricted import denied",
        agent_config=None,
        event_bus=event_bus,
        user_role=None,
        session_id="session-import-deny",
    )

    assert result.success is False
    assert "禁止导入模块: pathlib" in result.content
    assert "生产环境暂不允许该包" in result.content
    assert published["event"].data["tool_name"] == "sandbox_module_import"


# ─── 新增测试：沙箱完善 ───


def test_time_module_available():
    """time 模块应在白名单中，可直接使用"""
    result = execute_code_sandbox(
        code="import time\nresult = type(time.time()).__name__",
        description="time module available",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content == "float"


def test_time_sleep_respects_timeout():
    """time.sleep 受超时保护"""
    result = execute_code_sandbox(
        code="import time\ntime.sleep(100)\nresult = 'done'",
        description="time.sleep timeout",
        timeout=2,
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is False
    assert "超时" in result.content


def test_path_ops_available():
    """path_ops 对象应注入到沙箱，提供安全路径操作"""
    result = execute_code_sandbox(
        code=(
            "result = {\n"
            "    'join': path_ops.join('/a', 'b', 'c.txt'),\n"
            "    'basename': path_ops.basename('/a/b/c.txt'),\n"
            "    'dirname': path_ops.dirname('/a/b/c.txt'),\n"
            "    'splitext': list(path_ops.splitext('file.csv')),\n"
            "}"
        ),
        description="path_ops available",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content["basename"] == "c.txt"
    assert result.content["splitext"] == ["file", ".csv"]


def test_static_check_ignores_comments():
    """静态检查应跳过注释行中的禁止模式"""
    result = execute_code_sandbox(
        code="# import os\n# eval('1+1')\nresult = 42",
        description="comments not flagged",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content == 42


def test_static_check_blocks_real_import():
    """静态检查应拦截真正的 import os"""
    result = execute_code_sandbox(
        code="import os\nresult = os.getcwd()",
        description="real import blocked",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is False
    assert "禁止导入模块" in result.content


def test_getattr_no_longer_blocked():
    """getattr 不再被静态检查拦截"""
    result = execute_code_sandbox(
        code="result = getattr({'a': 1}, 'get')('a')",
        description="getattr allowed",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content == 1


def test_set_result_converted_to_list():
    """set 类型结果应自动转为 list"""
    result = execute_code_sandbox(
        code="result = {3, 1, 2}",
        description="set serialization",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert isinstance(result.content, list)
    assert sorted(result.content) == [1, 2, 3]


def test_datetime_result_converted_to_isoformat():
    """datetime 类型结果应自动转为 isoformat 字符串"""
    result = execute_code_sandbox(
        code="import datetime\nresult = datetime.datetime(2025, 1, 15, 10, 30, 0)",
        description="datetime serialization",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content == "2025-01-15T10:30:00"


def test_callable_and_ascii_builtins():
    """callable 和 ascii 应在沙箱内置函数中可用"""
    result = execute_code_sandbox(
        code="result = [callable(len), ascii('中文')]",
        description="callable and ascii builtins",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content[0] is True
    assert "\\u" in result.content[1]


def test_re_compile_not_blocked():
    """re.compile() 不应被静态检查拦截"""
    result = execute_code_sandbox(
        code="import re\npattern = re.compile(r'\\d+')\nresult = pattern.findall('abc123def456')",
        description="re.compile allowed",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert result.success is True
    assert result.content == ['123', '456']




def test_execute_code_while_true_timeout_process_cleanup():
    result = execute_code_sandbox(
        code="while True:\n    pass",
        description="busy loop timeout",
        timeout=1,
        agent_config=None,
        event_bus=None,
        user_role=None,
    )

    assert result.success is False
    assert "超时" in result.content

    follow_up = execute_code_sandbox(
        code="result = 'ok'",
        description="follow up after timeout",
        timeout=2,
        agent_config=None,
        event_bus=None,
        user_role=None,
    )
    assert follow_up.success is True
    assert follow_up.content == 'ok'


def test_execute_code_cancel_terminates_subprocess():
    cancel_event = threading.Event()

    def trigger_cancel():
        cancel_event.set()

    threading.Timer(0.3, trigger_cancel).start()
    result = execute_code_sandbox(
        code="while True:\n    pass",
        description="cancel busy loop",
        timeout=10,
        agent_config=None,
        event_bus=None,
        user_role=None,
        cancel_event=cancel_event,
    )

    assert result.success is False
    assert "取消" in result.content or "中断" in result.content


def test_execute_code_stdout_and_result_roundtrip():
    result = execute_code_sandbox(
        code="print('hello sandbox')\nresult = {'value': 42}",
        description="stdout and result",
        agent_config=None,
        event_bus=None,
        user_role=None,
    )

    assert result.success is True
    assert result.content == {'value': 42}
    assert 'hello sandbox' in result.metadata['stdout']


def test_execute_code_subprocess_call_tool_roundtrip(monkeypatch):
    captured = {}

    def _fake_execute_tool(*, tool_name, arguments, agent_config, event_bus, user_role, caller, session_id, cancel_event=None):
        captured['tool_name'] = tool_name
        captured['arguments'] = arguments
        captured['caller'] = caller
        captured['session_id'] = session_id
        return success_result(content={'items': [1, 2]}, summary='ok', output_type='json', tool_name=tool_name)

    monkeypatch.setattr('tools.runtime.executor.execute_tool', _fake_execute_tool)
    result = execute_code_sandbox(
        code="result = call_tool('preview_data_structure', {'file_path': 'sample.json'})",
        description='subprocess tool call',
        agent_config=None,
        event_bus=None,
        user_role=None,
        session_id='session-subprocess-call',
    )

    assert result.success is True
    assert result.content == {'items': [1, 2]}
    assert captured['tool_name'] == 'preview_data_structure'
    assert captured['caller'] == 'code_execution'
    assert captured['session_id'] == 'session-subprocess-call'


def test_execute_code_approval_wait_does_not_count_timeout(monkeypatch):
    registry = _FakeApprovalRegistry()
    monkeypatch.setattr('tools.local.code_sandbox.get_task_registry', lambda: registry)

    event_bus = MagicMock()

    def fake_publish(event):
        if getattr(event, 'type', None) != 'user.approval_required':
            return

        def approve_later():
            import time
            time.sleep(1.2)
            registry.resolve_approval(event.session_id, event.data['approval_id'], True, '允许')

        threading.Thread(target=approve_later).start()

    event_bus.publish = fake_publish
    result = execute_code_sandbox(
        code="from pathlib import Path\nresult = Path('demo.txt').name",
        description='approval pause timeout',
        timeout=1,
        agent_config=None,
        event_bus=event_bus,
        user_role=None,
        session_id='session-approval-timeout',
    )

    assert result.success is True
    assert result.content == 'demo.txt'


def test_execute_code_subprocess_abnormal_exit_returns_error(monkeypatch):
    import tools.local.code_sandbox as sandbox_module

    monkeypatch.setattr(sandbox_module, '_sandbox_worker', _crash_worker_for_test)
    result = execute_code_sandbox(
        code="result = 1",
        description='worker abnormal exit',
        agent_config=None,
        event_bus=None,
        user_role=None,
    )

    assert result.success is False
    assert '异常退出' in result.content


import logging
from unittest.mock import patch

from tools.contracts.result_models import ToolExecutionResult
from tools.runtime.executor import execute_tool


def test_execute_tool_logs_exception_with_exc_info(caplog):
    caplog.set_level(logging.ERROR)

    def boom_tool(**kwargs):
        raise RuntimeError("boom")

    with patch("tools.runtime.executor.get_tool_handler", return_value=boom_tool), \
         patch("tools.runtime.executor._TOOL_REGISTRY.is_mcp_tool", return_value=False), \
         patch("tools.runtime.executor.request_user_approval_if_needed") as mock_approval, \
         patch("tools.runtime.executor._run_hooks_sync", return_value=None):
        mock_approval.return_value = type(
            "ApprovalOutcome",
            (),
            {
                "allowed": True,
                "error_result": None,
                "approval_metadata": {},
                "approval_message": "",
                "approved_external_paths": [],
            },
        )()

        result = execute_tool("boom_tool", arguments={})

    assert isinstance(result, ToolExecutionResult)
    assert result.success is False
    assert result.tool_name == "boom_tool"
    assert any(record.levelno == logging.ERROR and record.exc_info for record in caplog.records)
    assert "执行工具 boom_tool 失败" in caplog.text

# -*- coding: utf-8 -*-
"""Tests for tool-specific observation formatters (bash, grep, glob, web_fetch)."""

import re

from agents.context.observation_formatters import (
    FormatContext,
    get_default_registry,
)
from agents.context.observation_formatters.bash import BashObservationFormatter
from agents.context.observation_formatters.grep import GrepObservationFormatter
from agents.context.observation_formatters.glob_fmt import GlobObservationFormatter
from agents.context.observation_formatters.web_fetch import WebFetchObservationFormatter
from tools.contracts.result_models import ToolExecutionResult

EMOJI_PATTERN = re.compile(
    "[\U0001F300-\U0001F9FF\U00002702-\U000027B0\U0000FE00-\U0000FE0F"
    "\U0000200D\U00002600-\U000026FF\U00002700-\U000027BF]"
)


def _make_result(content, tool_name="", summary="", output_type="json", **kwargs):
    return ToolExecutionResult(
        success=True,
        tool_name=tool_name,
        content=content,
        summary=summary,
        output_type=output_type,
        **kwargs,
    )


def _ctx(tool_name):
    return FormatContext(tool_name=tool_name, mode="inline")


# ── BashObservationFormatter ──────────────────────────────────────────


class TestBashFormatter:
    fmt = BashObservationFormatter()

    def test_success_rc0_only_stdout(self):
        result = _make_result(
            {"stdout": "hello world", "stderr": "", "return_code": 0,
             "interrupted": False, "background_task_id": None, "classification": "READ_ONLY"},
            tool_name="execute_bash",
            summary="命令执行完成，返回码 0",
        )
        obs = self.fmt.format(result, _ctx("execute_bash"))
        assert "hello world" in obs
        assert "classification" not in obs
        assert "background_task_id" not in obs
        assert "interrupted" not in obs

    def test_success_with_stderr(self):
        result = _make_result(
            {"stdout": "ok", "stderr": "warning: something", "return_code": 0,
             "interrupted": False, "background_task_id": None, "classification": "WRITE"},
            tool_name="execute_bash",
            summary="命令执行完成，返回码 0",
        )
        obs = self.fmt.format(result, _ctx("execute_bash"))
        assert "ok" in obs
        assert "[stderr]" in obs
        assert "warning: something" in obs

    def test_failure_rc_nonzero(self):
        result = _make_result(
            {"stdout": "", "stderr": "command not found", "return_code": 127,
             "interrupted": False, "background_task_id": None, "classification": "UNKNOWN"},
            tool_name="execute_bash",
            summary="命令执行完成，返回码 127",
        )
        obs = self.fmt.format(result, _ctx("execute_bash"))
        assert "127" in obs
        assert "command not found" in obs

    def test_background_task(self):
        result = _make_result(
            {"stdout": "", "stderr": "", "return_code": None,
             "interrupted": False, "background_task_id": "bg-123", "classification": "READ_ONLY"},
            tool_name="execute_bash",
            summary="后台任务已启动",
        )
        obs = self.fmt.format(result, _ctx("execute_bash"))
        assert "task_id: bg-123" in obs
        assert "classification" not in obs.lower() or "classification" not in obs.split("task_id")[0]

    def test_interrupted(self):
        result = _make_result(
            {"stdout": "partial output", "stderr": "", "return_code": -1,
             "interrupted": True, "background_task_id": None, "classification": "READ_ONLY"},
            tool_name="execute_bash",
            summary="命令执行超时（60 秒），进程已终止",
        )
        obs = self.fmt.format(result, _ctx("execute_bash"))
        assert "超时" in obs
        assert "partial output" in obs

    def test_strips_noise_fields(self):
        result = _make_result(
            {"stdout": "data", "stderr": "", "return_code": 0,
             "interrupted": False, "background_task_id": None, "classification": "READ_ONLY"},
            tool_name="execute_bash",
            summary="命令执行完成，返回码 0",
        )
        obs = self.fmt.format(result, _ctx("execute_bash"))
        assert "READ_ONLY" not in obs
        assert "null" not in obs.lower()
        assert "false" not in obs.lower()

    def test_can_handle(self):
        result = _make_result({}, tool_name="execute_bash")
        assert self.fmt.can_handle(result, _ctx("execute_bash"))
        assert not self.fmt.can_handle(result, _ctx("grep"))
        assert not self.fmt.can_handle(result, FormatContext(tool_name="execute_bash", mode="artifact_ref"))


# ── GrepObservationFormatter ─────────────────────────────────────────


class TestGrepFormatter:
    fmt = GrepObservationFormatter()

    def test_normal_output(self):
        result = _make_result(
            {"output": "file.py:42:def foo():\nfile.py:100:def bar():",
             "matches": ["file.py:42:def foo():", "file.py:100:def bar():"],
             "count": 2, "truncated": False, "durationMs": 15},
            tool_name="grep",
        )
        obs = self.fmt.format(result, _ctx("grep"))
        assert "找到 2 个匹配" in obs
        assert "file.py:42:def foo():" in obs
        assert "durationMs" not in obs
        assert "matches" not in obs  # the key name should not appear

    def test_empty_output(self):
        result = _make_result(
            {"output": "", "matches": [], "count": 0, "truncated": False, "durationMs": 5},
            tool_name="grep",
        )
        obs = self.fmt.format(result, _ctx("grep"))
        assert "未找到匹配" in obs

    def test_truncated(self):
        result = _make_result(
            {"output": "line1\nline2", "matches": ["line1", "line2"],
             "count": 2, "truncated": True, "durationMs": 10},
            tool_name="grep",
        )
        obs = self.fmt.format(result, _ctx("grep"))
        assert "截断" in obs

    def test_error(self):
        result = _make_result(
            {"error": "Search timed out", "output": "", "matches": [],
             "count": 0, "truncated": False, "durationMs": 5000},
            tool_name="grep",
        )
        obs = self.fmt.format(result, _ctx("grep"))
        assert "[ERROR]" in obs
        assert "Search timed out" in obs

    def test_can_handle(self):
        result = _make_result({}, tool_name="grep")
        assert self.fmt.can_handle(result, _ctx("grep"))
        assert not self.fmt.can_handle(result, _ctx("execute_bash"))


# ── GlobObservationFormatter ─────────────────────────────────────────


class TestGlobFormatter:
    fmt = GlobObservationFormatter()

    def test_normal_output(self):
        result = _make_result(
            {"filenames": ["src/a.py", "src/b.py", "src/c.py"],
             "numFiles": 3, "truncated": False, "durationMs": 8},
            tool_name="glob",
        )
        obs = self.fmt.format(result, _ctx("glob"))
        assert "找到 3 个文件" in obs
        assert "src/a.py" in obs
        assert "src/b.py" in obs
        assert "src/c.py" in obs
        assert "durationMs" not in obs

    def test_empty_output(self):
        result = _make_result(
            {"filenames": [], "numFiles": 0, "truncated": False, "durationMs": 2},
            tool_name="glob",
        )
        obs = self.fmt.format(result, _ctx("glob"))
        assert "未找到匹配文件" in obs

    def test_truncated(self):
        result = _make_result(
            {"filenames": ["a.py"], "numFiles": 1, "truncated": True, "durationMs": 5},
            tool_name="glob",
        )
        obs = self.fmt.format(result, _ctx("glob"))
        assert "截断" in obs

    def test_error(self):
        result = _make_result(
            {"error": "Glob search failed", "filenames": [],
             "numFiles": 0, "truncated": False, "durationMs": 0},
            tool_name="glob",
        )
        obs = self.fmt.format(result, _ctx("glob"))
        assert "[ERROR]" in obs

    def test_can_handle(self):
        result = _make_result({}, tool_name="glob")
        assert self.fmt.can_handle(result, _ctx("glob"))


# ── WebFetchObservationFormatter ─────────────────────────────────────


class TestWebFetchFormatter:
    fmt = WebFetchObservationFormatter()

    def test_normal_output(self):
        result = _make_result(
            {"content": "# Page Title\nSome content here",
             "truncated": False, "total_length": 30, "url": "https://example.com",
             "start_index": 0, "end_index": 30},
            tool_name="web_fetch",
        )
        obs = self.fmt.format(result, _ctx("web_fetch"))
        assert "URL: https://example.com" in obs
        assert "# Page Title" in obs
        assert "start_index" not in obs
        assert "end_index" not in obs
        assert "total_length" not in obs

    def test_truncated(self):
        result = _make_result(
            {"content": "partial content",
             "truncated": True, "total_length": 50000, "url": "https://example.com",
             "start_index": 0, "end_index": 5000},
            tool_name="web_fetch",
        )
        obs = self.fmt.format(result, _ctx("web_fetch"))
        assert "截断" in obs
        assert "50000" in obs
        assert "start_index=5000" in obs

    def test_error(self):
        result = _make_result(
            {"error": "Connection refused", "content": ""},
            tool_name="web_fetch",
        )
        obs = self.fmt.format(result, _ctx("web_fetch"))
        assert "[ERROR]" in obs
        assert "Connection refused" in obs

    def test_can_handle(self):
        result = _make_result({}, tool_name="web_fetch")
        assert self.fmt.can_handle(result, _ctx("web_fetch"))
        assert not self.fmt.can_handle(result, _ctx("grep"))


# ── Cross-cutting: No emoji in any formatter ─────────────────────────


class TestNoEmojiInFormatters:
    """Verify that no formatter emits emoji characters."""

    def _format_with_registry(self, result, tool_name):
        from copy import deepcopy
        registry = deepcopy(get_default_registry())
        ctx = FormatContext(tool_name=tool_name, mode="inline")
        return registry.format(result, ctx)

    def test_text_formatter_no_emoji(self):
        result = _make_result("hello", tool_name="read_file", summary="读取成功", output_type="text")
        obs = self._format_with_registry(result, "read_file")
        assert not EMOJI_PATTERN.search(obs), f"Found emoji in text output: {obs}"

    def test_json_formatter_no_emoji(self):
        result = _make_result({"key": "value"}, tool_name="preview_data_structure", summary="预览成功")
        obs = self._format_with_registry(result, "preview_data_structure")
        assert not EMOJI_PATTERN.search(obs), f"Found emoji in json output: {obs}"

    def test_error_no_emoji(self):
        result = ToolExecutionResult(success=False, tool_name="test", content="something failed")
        from copy import deepcopy
        registry = deepcopy(get_default_registry())
        ctx = FormatContext(tool_name="test", mode="inline")
        obs = registry.format(result, ctx)
        assert not EMOJI_PATTERN.search(obs), f"Found emoji in error output: {obs}"

    def test_bash_no_emoji(self):
        result = _make_result(
            {"stdout": "ok", "stderr": "", "return_code": 0,
             "interrupted": False, "background_task_id": None, "classification": "READ_ONLY"},
            tool_name="execute_bash", summary="命令执行完成，返回码 0",
        )
        obs = self._format_with_registry(result, "execute_bash")
        assert not EMOJI_PATTERN.search(obs), f"Found emoji in bash output: {obs}"


# ── llm_hint unified append ──────────────────────────────────────────


class TestLlmHintAppend:
    def test_llm_hint_appended(self):
        from copy import deepcopy
        registry = deepcopy(get_default_registry())
        result = _make_result(
            "file content", tool_name="read_file", summary="读取成功", output_type="text",
        )
        result.llm_hint = "可用 preview_data_structure 查看结构"
        ctx = FormatContext(tool_name="read_file", mode="inline")
        obs = registry.format(result, ctx)
        assert "可用 preview_data_structure 查看结构" in obs
        assert obs.endswith("可用 preview_data_structure 查看结构")

    def test_no_llm_hint_when_none(self):
        from copy import deepcopy
        registry = deepcopy(get_default_registry())
        result = _make_result("content", tool_name="read_file", summary="ok", output_type="text")
        ctx = FormatContext(tool_name="read_file", mode="inline")
        obs = registry.format(result, ctx)
        assert obs == "ok\n\ncontent"

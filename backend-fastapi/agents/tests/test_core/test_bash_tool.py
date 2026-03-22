# -*- coding: utf-8 -*-

from tools.tool_executor_modules.bash_tool import _split_shell_pipeline, _validate_command


def test_split_shell_pipeline_preserves_regex_pipe_inside_double_quotes():
    command = 'find . -name "*.json" | grep -i "nanning\\|南宁\\|boundary\\|admin" | head -20'

    segments = _split_shell_pipeline(command)

    assert segments == [
        'find . -name "*.json" ',
        ' grep -i "nanning\\|南宁\\|boundary\\|admin" ',
        ' head -20',
    ]


def test_validate_command_allows_escaped_regex_pipe_in_grep_pattern():
    command = 'find . -name "*.json" | grep -i "nanning\\|南宁\\|boundary\\|admin" | head -20'

    valid, err = _validate_command(command)

    assert valid is True
    assert err == ""


def test_validate_command_still_rejects_non_whitelisted_pipeline_command():
    valid, err = _validate_command('find . -name "*.json" | python -V')

    assert valid is False
    assert "禁止执行危险命令: python" in err

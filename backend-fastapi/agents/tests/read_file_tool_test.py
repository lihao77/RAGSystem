import threading
from pathlib import Path
from unittest.mock import MagicMock
import sys

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.document_executor import (
    FILE_SIZE_PREVIEW_THRESHOLD,
    read_file,
    edit_file,
)


# ───────────────────── read_file: 原始内容模式 ─────────────────────

def test_read_file_default_reads_all_small_file(tmp_path):
    """小文件默认读取全部内容。"""
    fp = tmp_path / "small.txt"
    fp.write_text("line1\nline2\nline3\n", encoding="utf-8")

    result = read_file(str(fp))

    assert result.success is True
    assert "line1" in result.content
    assert "line2" in result.content
    assert "line3" in result.content
    assert result.metadata["total_lines"] == 3
    assert result.metadata["start_line"] == 1
    assert result.metadata["end_line"] == 3
    assert result.metadata["has_more"] is False
    assert result.metadata["next_offset"] is None


def test_read_file_offset_and_limit(tmp_path):
    """offset/limit 分页读取。"""
    fp = tmp_path / "lines.txt"
    lines = [f"line{i}" for i in range(1, 11)]
    fp.write_text("\n".join(lines), encoding="utf-8")

    result = read_file(str(fp), offset=3, limit=4)

    assert result.success is True
    assert result.metadata["start_line"] == 3
    assert result.metadata["end_line"] == 6
    assert result.metadata["has_more"] is True
    assert result.metadata["next_offset"] == 7
    # 应该包含 line3 到 line6
    assert "line3" in result.content
    assert "line6" in result.content
    # 不应包含 line2 或 line7
    assert "line2" not in result.content
    assert "line7" not in result.content


def test_read_file_raw_content_format(tmp_path):
    """输出格式为原始内容（无行号）。"""
    fp = tmp_path / "fmt.txt"
    fp.write_text("alpha\nbeta\n", encoding="utf-8")

    result = read_file(str(fp))

    lines = result.content.split("\n")
    assert lines[0] == "alpha"
    assert lines[1] == "beta"


def test_read_file_keeps_long_lines(tmp_path):
    """长行应完整返回，不做单行截断。"""
    fp = tmp_path / "long.txt"
    long_line = "x" * 2500
    fp.write_text(long_line + "\nshort\n", encoding="utf-8")

    result = read_file(str(fp))

    first_line = result.content.split("\n")[0]
    assert first_line == long_line
    assert "[TRUNCATED]" not in first_line


def test_read_file_offset_beyond_total_lines(tmp_path):
    """offset 超出文件行数时返回空内容。"""
    fp = tmp_path / "tiny.txt"
    fp.write_text("only one line\n", encoding="utf-8")

    result = read_file(str(fp), offset=100)

    assert result.success is True
    assert result.content == ""
    assert result.metadata["has_more"] is False


def test_read_file_rejects_invalid_offset(tmp_path):
    """offset < 1 报错。"""
    fp = tmp_path / "x.txt"
    fp.write_text("a", encoding="utf-8")

    result = read_file(str(fp), offset=0)
    assert result.success is False
    assert "offset" in result.content


def test_read_file_nonexistent():
    """读取不存在的文件报错。"""
    result = read_file("/nonexistent/path/file.txt")
    assert result.success is False
    assert "不存在" in result.content


# ───────────────── read_file: 5KB 大文件确认 ──────────────────

def _make_large_file(tmp_path, size_bytes=6000):
    """创建超过 5KB 的文件。"""
    fp = tmp_path / "large.txt"
    content = "A" * size_bytes
    fp.write_text(content, encoding="utf-8")
    return fp


def test_read_file_large_file_confirm_approved(tmp_path):
    """大文件 + direct caller + 用户批准 → 返回完整内容。"""
    fp = _make_large_file(tmp_path)

    event_bus = MagicMock()
    session_id = "test-session-1"

    # 模拟审批机制：发布事件后立刻在另一个线程批准
    from agents.task_registry import get_task_registry
    registry = get_task_registry()

    original_publish = event_bus.publish

    def fake_publish(event):
        approval_id = event.data.get("approval_id")
        # 在另一个线程中批准
        def approve():
            registry.resolve_approval(session_id, approval_id, True, "")
        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    result = read_file(str(fp), caller="direct", event_bus=event_bus, session_id=session_id)

    assert result.success is True
    # 应该返回完整内容（带行号），而非仅预览
    assert "preview_only" not in result.metadata or result.metadata.get("preview_only") is not True


def test_read_file_large_file_confirm_denied(tmp_path):
    """大文件 + direct caller + 用户拒绝 → 返回预览。"""
    fp = _make_large_file(tmp_path)

    event_bus = MagicMock()
    session_id = "test-session-2"

    from agents.task_registry import get_task_registry
    registry = get_task_registry()

    def fake_publish(event):
        approval_id = event.data.get("approval_id")
        def deny():
            registry.resolve_approval(session_id, approval_id, False, "")
        threading.Thread(target=deny).start()

    event_bus.publish = fake_publish

    result = read_file(str(fp), caller="direct", event_bus=event_bus, session_id=session_id)

    assert result.success is True
    assert result.metadata.get("preview_only") is True


def test_read_file_large_file_code_execution_no_confirm(tmp_path):
    """code_execution caller 读大文件 → 不触发确认，直接返回。"""
    fp = _make_large_file(tmp_path)

    event_bus = MagicMock()
    session_id = "test-session-3"

    result = read_file(str(fp), caller="code_execution", event_bus=event_bus, session_id=session_id)

    assert result.success is True
    # 不应该发布审批事件
    event_bus.publish.assert_not_called()
    assert "preview_only" not in result.metadata or result.metadata.get("preview_only") is not True


def test_read_file_small_file_no_confirm(tmp_path):
    """小文件 + direct caller → 不触发确认。"""
    fp = tmp_path / "small.txt"
    fp.write_text("tiny\n", encoding="utf-8")

    event_bus = MagicMock()

    result = read_file(str(fp), caller="direct", event_bus=event_bus, session_id="s1")

    assert result.success is True
    event_bus.publish.assert_not_called()


# ─────────────────────── edit_file ─────────────────────────

def test_edit_file_unique_match(tmp_path):
    """唯一匹配时成功替换。"""
    fp = tmp_path / "edit.txt"
    fp.write_text("hello world\nfoo bar\n", encoding="utf-8")

    result = edit_file(str(fp), old_string="hello world", new_string="hi world")

    assert result.success is True
    assert result.content["replacements"] == 1
    assert fp.read_text(encoding="utf-8") == "hi world\nfoo bar\n"
    assert "diff_preview" in result.content


def test_edit_file_no_match(tmp_path):
    """无匹配时报错。"""
    fp = tmp_path / "edit2.txt"
    fp.write_text("hello world\n", encoding="utf-8")

    result = edit_file(str(fp), old_string="xyz", new_string="abc")

    assert result.success is False
    assert "未找到" in result.content


def test_edit_file_multiple_match_error(tmp_path):
    """多处匹配且 replace_all=false 时报错。"""
    fp = tmp_path / "edit3.txt"
    fp.write_text("aaa bbb aaa\n", encoding="utf-8")

    result = edit_file(str(fp), old_string="aaa", new_string="ccc")

    assert result.success is False
    assert "不唯一" in result.content
    assert "2" in result.content  # 提示匹配次数


def test_edit_file_replace_all(tmp_path):
    """replace_all=true 替换所有匹配。"""
    fp = tmp_path / "edit4.txt"
    fp.write_text("aaa bbb aaa\n", encoding="utf-8")

    result = edit_file(str(fp), old_string="aaa", new_string="ccc", replace_all=True)

    assert result.success is True
    assert result.content["replacements"] == 2
    assert fp.read_text(encoding="utf-8") == "ccc bbb ccc\n"


def test_edit_file_empty_new_string_deletes(tmp_path):
    """new_string 为空字符串 → 删除匹配内容。"""
    fp = tmp_path / "edit5.txt"
    fp.write_text("keep this remove_me and this\n", encoding="utf-8")

    result = edit_file(str(fp), old_string="remove_me ", new_string="")

    assert result.success is True
    assert fp.read_text(encoding="utf-8") == "keep this and this\n"


def test_edit_file_nonexistent():
    """编辑不存在的文件报错。"""
    result = edit_file("/nonexistent/path/file.txt", old_string="a", new_string="b")
    assert result.success is False
    assert "不存在" in result.content

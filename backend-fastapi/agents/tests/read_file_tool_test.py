from pathlib import Path
import sys

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.document_executor import DEFAULT_READ_MAX_CHARS, read_file


def test_read_file_defaults_to_safe_window(tmp_path):
    file_path = tmp_path / "large.txt"
    file_path.write_text("0123456789" * 500, encoding="utf-8")

    result = read_file(str(file_path))

    assert result.success is True
    assert len(result.content) == DEFAULT_READ_MAX_CHARS
    assert result.metadata["start"] == 0
    assert result.metadata["end"] == DEFAULT_READ_MAX_CHARS
    assert result.metadata["has_more"] is True
    assert result.metadata["next_start"] == DEFAULT_READ_MAX_CHARS
    assert result.metadata["truncated"] is True
    assert f"start={DEFAULT_READ_MAX_CHARS}" in result.summary


def test_read_file_supports_explicit_character_range(tmp_path):
    file_path = tmp_path / "sample.txt"
    file_path.write_text("abcdefghijklmnopqrstuvwxyz", encoding="utf-8")

    result = read_file(str(file_path), start=5, end=10)

    assert result.success is True
    assert result.content == "fghij"
    assert result.metadata["start"] == 5
    assert result.metadata["end"] == 10
    assert result.metadata["has_more"] is True
    assert result.metadata["next_start"] == 10
    assert "start=10" in result.summary


def test_read_file_rejects_invalid_ranges(tmp_path):
    file_path = tmp_path / "sample.txt"
    file_path.write_text("hello", encoding="utf-8")

    result = read_file(str(file_path), start=4, end=3)

    assert result.success is False
    assert "end 不能小于 start" in result.content

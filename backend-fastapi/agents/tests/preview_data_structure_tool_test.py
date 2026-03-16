from pathlib import Path
import sys

import pytest

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.document_executor import preview_data_structure


def test_preview_data_structure_json_nested(tmp_path):
    fp = tmp_path / "sample.json"
    fp.write_text(
        '{"name":"dataset","items":[{"id":1,"tags":["a","b"],"meta":{"city":"Nanning"}}]}',
        encoding="utf-8",
    )

    result = preview_data_structure(str(fp))

    assert result.success is True
    assert result.content["file_type"] == "json"
    structure = result.content["structure"]
    assert structure["type"] == "object"
    assert structure["fields"]["name"]["type"] == "string"
    assert structure["fields"]["items"]["type"] == "array"
    assert structure["fields"]["items"]["item_structure"]["fields"]["id"]["types"] == ["integer"]


def test_preview_data_structure_csv_columns_and_types(tmp_path):
    fp = tmp_path / "sample.csv"
    fp.write_text(
        "name,age,active\nAlice,30,true\nBob,28,false\n",
        encoding="utf-8",
    )

    result = preview_data_structure(str(fp))

    assert result.success is True
    assert result.content["file_type"] == "csv"
    structure = result.content["structure"]
    assert structure["root_type"] == "table"
    assert structure["columns"] == ["name", "age", "active"]
    assert structure["column_types"]["age"]["types"] == ["integer"]
    assert structure["column_types"]["active"]["types"] == ["boolean"]
    assert structure["sample_rows"][0]["name"] == "Alice"


def test_preview_data_structure_yaml_object(tmp_path):
    pytest.importorskip("yaml")

    fp = tmp_path / "sample.yaml"
    fp.write_text(
        "service:\n  name: api\n  replicas: 3\nfeatures:\n  - search\n  - export\n",
        encoding="utf-8",
    )

    result = preview_data_structure(str(fp), max_depth=2)

    assert result.success is True
    assert result.content["file_type"] == "yaml"
    structure = result.content["structure"]
    assert structure["type"] == "object"
    assert structure["fields"]["service"]["type"] == "object"
    assert structure["fields"]["features"]["type"] == "array"


def test_preview_data_structure_text_summary(tmp_path):
    fp = tmp_path / "notes.txt"
    fp.write_text("alpha\n\nbeta line\ncharlie\n", encoding="utf-8")

    result = preview_data_structure(str(fp), max_preview_rows=2)

    assert result.success is True
    assert result.content["file_type"] == "txt"
    structure = result.content["structure"]
    assert structure["root_type"] == "text"
    assert structure["total_lines"] == 4
    assert structure["non_empty_lines"] == 3
    assert structure["preview_lines"] == ["alpha", ""]


def test_preview_data_structure_rejects_invalid_limits(tmp_path):
    fp = tmp_path / "sample.json"
    fp.write_text("{}", encoding="utf-8")

    result = preview_data_structure(str(fp), max_depth=0)

    assert result.success is False
    assert "max_depth" in result.content

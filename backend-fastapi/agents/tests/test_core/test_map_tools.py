# -*- coding: utf-8 -*-
"""可视化 Skill 脚本 + artifact 协议桥接测试。"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "skills" / "visualization" / "scripts"


# ─── Skill 脚本直接执行测试 ──────────────────────────────────────

def _run_script(script_name, args):
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script_name)] + args,
        capture_output=True, text=True, timeout=15,
    )
    return proc, json.loads(proc.stdout) if proc.stdout.strip() else None


def test_create_chart_script_outputs_artifact():
    data = json.dumps([
        {"year": 2020, "pop": 100},
        {"year": 2021, "pop": 120},
    ])
    proc, output = _run_script("create_chart.py", [
        "--data", data, "--chart-type", "bar",
        "--x-field", "year", "--y-field", "pop", "--title", "Test",
    ])
    assert proc.returncode == 0
    assert output["success"] is True
    assert "artifact" in output
    assert output["artifact"]["viz_type"] == "chart"
    assert output["artifact"]["sub_type"] == "bar"
    assert "config" in output["artifact"]
    assert output["artifact"]["config"]["series"]


def test_create_chart_script_invalid_field():
    data = json.dumps([{"a": 1, "b": 2}])
    proc, output = _run_script("create_chart.py", [
        "--data", data, "--chart-type", "line",
        "--x-field", "a", "--y-field", "missing",
    ])
    assert proc.returncode == 1
    assert output["success"] is False


def test_create_map_script_outputs_artifact():
    data = json.dumps([
        {"name": "A", "value": 10, "geometry": "POINT (108.32 22.82)"},
        {"name": "B", "value": 20, "geometry": "POINT (110.29 25.27)"},
    ])
    proc, output = _run_script("create_map.py", [
        "--data", data, "--map-type", "marker",
        "--value-field", "value", "--name-field", "name",
    ])
    assert proc.returncode == 0
    assert output["success"] is True
    assert output["artifact"]["viz_type"] == "map"
    assert output["artifact"]["sub_type"] == "marker"
    config = output["artifact"]["config"]
    assert len(config["markers"]) == 2
    assert config["bounds"]


def test_revise_script_outputs_revise_action():
    proc, output = _run_script("revise.py", [
        "--artifact-id", "viz_test123",
        "--config-patch", '{"title":{"text":"new"}}',
    ])
    assert proc.returncode == 0
    assert output["success"] is True
    assert output["artifact"]["action"] == "revise"
    assert output["artifact"]["artifact_id"] == "viz_test123"


# ─── artifact 协议桥接测试（_handle_artifact） ────────────────────

from tools.tool_executor_modules.skill_tools import _handle_artifact


def test_handle_artifact_create_chart(tmp_path, monkeypatch):
    """测试 _handle_artifact 创建 chart 类型 artifact。"""
    class FakeRecord:
        artifact_id = "viz_fake001"
        viz_type = "chart"
        title = "Test"
        version = 1

    class FakeManager:
        def create_chart(self, **kwargs):
            assert kwargs["chart_type"] == "bar"
            return FakeRecord()

        def create_map(self, **kwargs):
            raise AssertionError("should not call create_map")

    monkeypatch.setattr(
        "tools.tool_executor_modules.skill_tools.get_visualization_artifact_manager",
        lambda: FakeManager(),
    )

    artifact_block = {
        "viz_type": "chart",
        "sub_type": "bar",
        "title": "Test",
        "config": {"series": [{"type": "bar"}]},
    }
    info, err = _handle_artifact(artifact_block, session_id="test-session")
    assert err is None
    assert info["artifact_id"] == "viz_fake001"
    assert info["viz_type"] == "chart"


def test_handle_artifact_create_map(monkeypatch):
    """测试 _handle_artifact 创建 map 类型 artifact。"""
    class FakeRecord:
        artifact_id = "viz_fake002"
        viz_type = "map"
        title = "Map"
        version = 1

    class FakeManager:
        def create_chart(self, **kwargs):
            raise AssertionError("should not call create_chart")

        def create_map(self, **kwargs):
            assert kwargs["map_type"] == "heatmap"
            return FakeRecord()

    monkeypatch.setattr(
        "tools.tool_executor_modules.skill_tools.get_visualization_artifact_manager",
        lambda: FakeManager(),
    )

    artifact_block = {
        "viz_type": "map",
        "sub_type": "heatmap",
        "title": "Map",
        "config": {"map_type": "heatmap", "markers": []},
    }
    info, err = _handle_artifact(artifact_block, session_id=None)
    assert err is None
    assert info["artifact_id"] == "viz_fake002"


def test_handle_artifact_revise(monkeypatch):
    """测试 _handle_artifact revise 操作。"""
    class FakeRecord:
        artifact_id = "viz_existing"
        viz_type = "chart"
        title = "Old"
        version = 2

    class FakeManager:
        def revise(self, artifact_id, config_patch, replace=False):
            assert artifact_id == "viz_existing"
            assert config_patch == {"title": {"text": "New"}}
            return FakeRecord()

    monkeypatch.setattr(
        "tools.tool_executor_modules.skill_tools.get_visualization_artifact_manager",
        lambda: FakeManager(),
    )

    artifact_block = {
        "action": "revise",
        "artifact_id": "viz_existing",
        "config": {"title": {"text": "New"}},
    }
    info, err = _handle_artifact(artifact_block, session_id=None)
    assert err is None
    assert info["artifact_id"] == "viz_existing"
    assert info["version"] == 2


def test_handle_artifact_missing_fields():
    """缺少必要字段时返回错误。"""
    info, err = _handle_artifact({"viz_type": "chart"}, session_id=None)
    assert err is not None
    assert "config" in err


def test_handle_artifact_revise_missing_id():
    info, err = _handle_artifact({"action": "revise", "config": {}}, session_id=None)
    assert err is not None
    assert "artifact_id" in err

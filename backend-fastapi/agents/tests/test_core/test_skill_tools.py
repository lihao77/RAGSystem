# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from agents.skills.skill_loader import SkillLoader
from tools.tool_executor_modules.skill_tools import execute_skill_script, get_skill_info
from tools.result_schema import ToolExecutionResult


def _make_temp_dir() -> str:
    return tempfile.mkdtemp(dir=Path(__file__).resolve().parent)


def test_skill_loader_can_find_metadata_without_loading_skill_content():
    temp_dir = Path(_make_temp_dir())
    try:
        skill_dir = temp_dir / "demo-skill"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\n"
            "name: demo-skill\n"
            "description: demo description\n"
            "---\n"
            "\n"
            "# Demo Skill\n"
            "full content should not be loaded here\n",
            encoding="utf-8",
        )
        (skill_dir / "reference.md").write_text("extra", encoding="utf-8")
        scripts_dir = skill_dir / "scripts"
        scripts_dir.mkdir()
        (scripts_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")

        loader = SkillLoader(skills_dir=temp_dir)

        metadata = loader.find_skill_metadata("demo-skill")

        assert metadata is not None
        assert metadata["name"] == "demo-skill"
        assert metadata["description"] == "demo description"
        assert metadata["skill_dir"] == skill_dir
        assert loader.count_skill_resources(skill_dir) == 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_get_skill_info_returns_native_result_and_skips_load_all_skills(monkeypatch):
    temp_dir = Path(_make_temp_dir())
    try:
        skill_dir = temp_dir / "demo-skill"
        skill_dir.mkdir()
        (skill_dir / "ref.md").write_text("extra", encoding="utf-8")
        (skill_dir / "scripts").mkdir()

        class StubLoader:
            def load_all_skills(self):
                raise AssertionError("get_skill_info should not call load_all_skills")

            def find_skill_metadata(self, skill_name):
                if skill_name != "demo-skill":
                    return None
                return {
                    "name": "demo-skill",
                    "description": "demo description",
                    "skill_dir": Path(skill_dir),
                    "metadata": {"name": "demo-skill", "description": "demo description"},
                }

            def list_skill_names(self):
                return ["demo-skill"]

            def count_skill_resources(self, skill_path):
                assert skill_path == Path(skill_dir)
                return 1

        monkeypatch.setattr("agents.skills.skill_loader.get_skill_loader", lambda: StubLoader())

        result = get_skill_info("demo-skill")

        assert isinstance(result, ToolExecutionResult)
        assert result.success is True
        assert result.content == {
            "name": "demo-skill",
            "description": "demo description",
            "has_scripts": True,
        }
        assert result.metadata["resource_count"] == 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
def test_execute_skill_script_returns_parsed_json_stdout(monkeypatch):
    class StubSkill:
        name = "demo-skill"

        def has_scripts(self):
            return True

        def execute_script(self, script_name, arguments=None, timeout=30):
            assert script_name == "fetch_hydrology.py"
            assert arguments == ["--source", "all"]
            assert timeout == 30
            return {
                "stdout": '{"river": [{"site_name": "柳州水文站"}], "reservoir": [{"site_name": "大藤峡水利枢纽"}]}',
                "stderr": "",
                "return_code": 0,
            }

    class StubLoader:
        def load_all_skills(self):
            return [StubSkill()]

    monkeypatch.setattr("agents.skills.skill_loader.get_skill_loader", lambda: StubLoader())

    result = execute_skill_script("demo-skill", "fetch_hydrology.py", ["--source", "all"])

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.output_type == "json"
    assert result.content == {
        "river": [{"site_name": "柳州水文站"}],
        "reservoir": [{"site_name": "大藤峡水利枢纽"}],
    }
    assert result.metadata["script_name"] == "fetch_hydrology.py"
    assert result.metadata["skill"] == "demo-skill"


def test_execute_skill_script_bridges_artifact_protocol(monkeypatch):
    class StubSkill:
        name = "demo-skill"

        def has_scripts(self):
            return True

        def execute_script(self, script_name, arguments=None, timeout=30):
            assert script_name == "create_chart.py"
            return {
                "stdout": '{"success": true, "data": {"title": "Test"}, "artifact": {"viz_type": "chart", "sub_type": "bar", "title": "Test", "config": {"series": [{"type": "bar"}]}}}',
                "stderr": "",
                "return_code": 0,
            }

    class StubLoader:
        def load_all_skills(self):
            return [StubSkill()]

    class FakeRecord:
        artifact_id = "viz_test001"
        viz_type = "chart"
        title = "Test"
        version = 1

    class FakeManager:
        def create_chart(self, **kwargs):
            assert kwargs["chart_type"] == "bar"
            return FakeRecord()

    monkeypatch.setattr("agents.skills.skill_loader.get_skill_loader", lambda: StubLoader())
    monkeypatch.setattr(
        "tools.visualization_artifact_manager.get_visualization_artifact_manager",
        lambda: FakeManager(),
    )

    result = execute_skill_script("demo-skill", "create_chart.py", [], session_id="session-1")

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.content["artifact_id"] == "viz_test001"
    assert result.content["viz_type"] == "chart"
    assert result.metadata["artifact_id"] == "viz_test001"
    assert result.output_type == "chart"
    assert result.llm_hint == "在 <final_answer> 中插入 [viz:viz_test001] 来展示此可视化"




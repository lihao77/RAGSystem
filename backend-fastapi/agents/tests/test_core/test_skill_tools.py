# -*- coding: utf-8 -*-

import json
import shutil
import tempfile
import time
from pathlib import Path

from agents.skills.skill_loader import SkillLoader
from tools.local.skill_tools import execute_skill_script, get_skill_info
from tools.contracts.result_models import ToolExecutionResult
from tools.runtime.background_tasks import get_background_task_manager


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


def test_execute_skill_script_unwraps_generate_report_payload(monkeypatch):
    class StubSkill:
        name = "emergency-decision-support"

        def has_scripts(self):
            return True

        def execute_script(self, script_name, arguments=None, timeout=30):
            assert script_name == "generate_report.py"
            assert arguments == ["--report-type", "situation_report", "--location", "南宁市"]
            return {
                "stdout": '{"success": true, "summary": "已生成综合态势报告（南宁市）", "data": {"report_type": "situation_report", "title": "综合态势报告", "location": "南宁市", "report_time": "2026-03-24 12:00", "sections": {"situation": {"summary": "持续强降雨"}, "risk": {}, "warning": {}, "plan": {}, "action": {}, "weather": {}}, "markdown": "# 综合态势报告\\n\\n### 一、态势概览\\n\\n持续强降雨\\n"}}',
                "stderr": "",
                "return_code": 0,
            }

    class StubLoader:
        def load_all_skills(self):
            return [StubSkill()]

    monkeypatch.setattr("agents.skills.skill_loader.get_skill_loader", lambda: StubLoader())

    result = execute_skill_script(
        "emergency-decision-support",
        "generate_report.py",
        ["--report-type", "situation_report", "--location", "南宁市"],
    )

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.output_type == "json"
    assert result.content["report_type"] == "situation_report"
    assert result.content["location"] == "南宁市"
    assert "markdown" in result.content
    assert result.content["markdown"].startswith("# 综合态势报告")
    assert result.metadata["summary"] == "已生成综合态势报告（南宁市）"
    assert result.metadata["script_name"] == "generate_report.py"
    assert result.metadata["skill"] == "emergency-decision-support"


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
        "tools.artifacts.visualization_artifact_manager.get_visualization_artifact_manager",
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


def test_execute_skill_script_bridges_team_protocol(monkeypatch):
    class StubSkill:
        name = "team-generation"

        def has_scripts(self):
            return True

        def execute_script(self, script_name, arguments=None, timeout=30):
            assert script_name == "generate_team.py"
            return {
                "stdout": '{"success": true, "data": {"reason": "用于专项任务", "agents": [{"agent_name": "planner_agent", "display_name": "规划专家", "description": "负责阶段规划", "default_entry": true}]}, "team": {"action": "create_or_replace", "team_name": "generated-team", "source_team": "default", "agents": {"planner_agent": {"enabled": true, "display_name": "规划专家", "description": "负责阶段规划", "default_entry": true, "llm_tiers": {"default": {"provider": "test", "model_name": "model-a"}}, "custom_params": {"behavior": {"system_prompt": "你是规划专家。"}, "type": "orchestrator"}}}}}',
                "stderr": "",
                "return_code": 0,
            }

    class StubLoader:
        def load_all_skills(self):
            return [StubSkill()]

    class FakeConfigManager:
        def apply_team_payload(self, team_name, agents_payload, source_team=None):
            assert team_name == 'generated-team'
            assert source_team == 'default'
            assert 'planner_agent' in agents_payload
            return {
                'team_name': 'generated-team',
                'agent_count': 1,
                'agents': ['planner_agent'],
                'source_team': 'default',
            }

    monkeypatch.setattr("agents.skills.skill_loader.get_skill_loader", lambda: StubLoader())
    monkeypatch.setattr("agents.config.get_config_manager", lambda: FakeConfigManager())

    result = execute_skill_script("team-generation", "generate_team.py", [])

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.content['team_name'] == 'generated-team'
    assert result.content['agent_count'] == 1
    assert result.content['applied'] is True
    assert result.metadata['team_name'] == 'generated-team'
    assert result.metadata['team_action'] == 'create_or_replace'
    assert result.metadata['team_applied'] is True


def test_execute_skill_script_background_returns_task_info_and_structured_output(monkeypatch):
    temp_dir = Path(_make_temp_dir())
    try:
        class StubSkill:
            name = "demo-skill"

            def has_scripts(self):
                return True

            def execute_script(self, script_name, arguments=None, timeout=30):
                assert script_name == "fetch_hydrology.py"
                assert arguments == ["--source", "all"]
                return {
                    "stdout": '{"river": [{"site_name": "柳州水文站"}]}',
                    "stderr": "",
                    "return_code": 0,
                }

        class StubLoader:
            def load_all_skills(self):
                return [StubSkill()]

        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        monkeypatch.setattr("agents.skills.skill_loader.get_skill_loader", lambda: StubLoader())
        monkeypatch.setattr(
            "tools.local.skill_tools.get_current_execution_observability_fields",
            lambda: {"run_id": "run-1", "task_id": "task-1"},
        )
        monkeypatch.setattr(
            "tools.local.skill_tools.get_session_transient_root",
            lambda session_id: temp_dir,
        )

        result = execute_skill_script(
            "demo-skill",
            "fetch_hydrology.py",
            ["--source", "all"],
            run_in_background=True,
            session_id="session-1",
        )

        assert isinstance(result, ToolExecutionResult)
        assert result.success is True
        assert result.content["background_started"] is True
        assert "suggest_wait" not in result.content
        assert result.metadata["background_kind"] == "callable"
        assert result.metadata["cancel_supported"] is False
        task_id = result.content["background_task_id"]
        assert task_id

        for _ in range(50):
            task = bg_manager.get_task(task_id)
            if task and task.is_done():
                break
            time.sleep(0.01)
        else:
            raise AssertionError("background task did not finish")

        task = bg_manager.get_task(task_id)
        assert task is not None
        assert task.status == "completed"
        assert task.result_type == "tool_execution_result"

        payload = json.loads(bg_manager.get_output(task_id))
        assert payload["success"] is True
        assert payload["result_type"] == "tool_execution_result"
        assert payload["result"]["tool_name"] == "execute_skill_script"
        assert payload["result"]["output_type"] == "json"
        assert payload["result"]["content"] == {"river": [{"site_name": "柳州水文站"}]}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_execute_skill_script_background_requires_session_id():
    result = execute_skill_script(
        "demo-skill",
        "fetch_hydrology.py",
        ["--source", "all"],
        run_in_background=True,
    )

    assert result.success is False
    assert "session_id" in result.summary


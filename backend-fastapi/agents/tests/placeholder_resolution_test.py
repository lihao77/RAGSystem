from pathlib import Path
from unittest.mock import MagicMock
import sys

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from agents.implementations.orchestrator.prompting import replace_placeholders
from agents.implementations.react.agent import ReActAgent
from tools.response_builder import success_result
from tools.result_references import resolve_result_path


class DummyOrchestratorAgent:
    def __init__(self):
        self.logger = MagicMock()

    def _replace_placeholders(self, data, agent_results):
        return replace_placeholders(self, data, agent_results)


class DummyReActAgent:
    def __init__(self):
        self.logger = MagicMock()

    _safe_json_dumps = ReActAgent._safe_json_dumps


def _build_result():
    return success_result(
        content={
            "risk_level": "III",
            "nested": {
                "risk_level": "II",
            },
        },
        summary="风险评估完成",
        tool_name="assess_flood_risk",
    )


def test_resolve_result_path_falls_back_to_primary_content_root():
    result = _build_result()

    assert resolve_result_path(result, "risk_level") is None
    assert resolve_result_path(
        result,
        "risk_level",
        prefer_primary_content_root=True,
    ) == "III"
    assert resolve_result_path(
        result,
        "RISK_LEVEL",
        prefer_primary_content_root=True,
        case_insensitive=True,
    ) == "III"


def test_orchestrator_replace_placeholders_supports_uppercase_and_content_root():
    agent = DummyOrchestratorAgent()
    result = _build_result()

    replaced = replace_placeholders(
        agent,
        {
            "risk_level": "{RESULT_1.RISK_LEVEL}",
            "explicit": "{result_1.content.risk_level}",
        },
        {1: result},
    )

    assert replaced["risk_level"] == "III"
    assert replaced["explicit"] == "III"


def test_react_tool_reference_resolution_supports_uppercase_and_content_root():
    agent = DummyReActAgent()
    result = _build_result()

    replaced = ReActAgent._resolve_tool_references(
        agent,
        {
            "risk_level": "{RESULT_1.RISK_LEVEL}",
            "explicit": "{result_1.content.risk_level}",
        },
        {1: result},
        2,
    )

    assert replaced["risk_level"] == "III"
    assert replaced["explicit"] == "III"

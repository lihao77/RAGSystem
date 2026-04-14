from pathlib import Path
from unittest.mock import MagicMock
import sys

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from agents.implementations.orchestrator.prompting import replace_placeholders
from agents.core import BaseAgent
from tools.runtime.response_builder import success_result
from tools.refs.result_references import resolve_result_path, is_ref_error, stringify_result_value, result_primary_content


class DummyOrchestratorAgent:
    def __init__(self):
        self.logger = MagicMock()

    def _replace_placeholders(self, data, agent_results):
        return replace_placeholders(self, data, agent_results)


class DummyReActAgent:
    def __init__(self):
        self.logger = MagicMock()

    def _resolve_references(self, arguments, results_snapshot, current_idx):
        del current_idx
        resolved = {}
        for key, value in arguments.items():
            if isinstance(value, str) and value.startswith("{") and value.endswith("}") and value[1:-1].lower().startswith("result_"):
                placeholder = value[1:-1]
                prefix, _, path = placeholder.partition(".")
                result_idx = int(prefix.lower().replace("result_", ""))
                resolved_value = (
                    result_primary_content(results_snapshot[result_idx])
                    if not path
                    else resolve_result_path(
                        results_snapshot[result_idx],
                        path,
                        prefer_primary_content_root=True,
                        case_insensitive=True,
                    )
                )
                resolved[key] = stringify_result_value(resolved_value) if not path else resolved_value
            else:
                resolved[key] = value
        return resolved


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

    assert is_ref_error(resolve_result_path(result, "risk_level"))
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

    replaced = agent._resolve_references(
        {
            "risk_level": "{RESULT_1.RISK_LEVEL}",
            "explicit": "{result_1.content.risk_level}",
        },
        {1: result},
        2,
    )

    assert replaced["risk_level"] == "III"
    assert replaced["explicit"] == "III"

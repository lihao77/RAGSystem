# -*- coding: utf-8 -*-

import json
import logging

from agents.core import AgentContext, AgentResponse
from agents.implementations.orchestrator.prompting import replace_placeholders
from services.agent_execution_service import AgentExecutionService
from tools.runtime.response_builder import error_result, success_result
from tools.refs.result_references import resolve_result_path, stringify_result_value, result_primary_content


class _FakeReActAgent:
    logger = logging.getLogger("test.react.placeholder")

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


class _FakeOrchestratorAgent:
    logger = logging.getLogger("test.orchestrator.placeholder")

    def _replace_placeholders(self, data, agent_results):
        return replace_placeholders(self, data, agent_results)


class _StubDelegatedAgent:
    def __init__(self, response):
        self.response = response

    def execute(self, task, context):
        del task, context
        return self.response


def test_react_tool_reference_supports_tool_execution_result_primary_content():
    fake_agent = _FakeReActAgent()
    arguments = {"data": "{result_1}"}
    tool_results = {
        1: success_result(
            content=[{"city": "Shanghai", "value": 12}],
            summary="ok",
            output_type="json",
            tool_name="get_skill_info",
        )
    }

    resolved = fake_agent._resolve_references(arguments, tool_results, current_idx=2)

    assert resolved["data"] == '[{"city": "Shanghai", "value": 12}]'


def test_react_tool_reference_supports_tool_execution_result_paths():
    fake_agent = _FakeReActAgent()
    arguments = {
        "name": "{result_1.content.name}",
    }
    tool_results = {
        1: success_result(
            content={"name": "demo-skill"},
            summary="ok",
            output_type="json",
            tool_name="get_skill_info",
        )
    }

    resolved = fake_agent._resolve_references(arguments, tool_results, current_idx=2)

    assert resolved["name"] == "demo-skill"


def test_master_placeholder_supports_tool_execution_result_and_failure_message():
    fake_agent = _FakeOrchestratorAgent()
    payload = {
        "task": "技能 {result_1.content.name}，失败 {result_2}",
    }
    agent_results = {
        1: success_result(
            content={"name": "demo-skill"},
            summary="ok",
            output_type="json",
            tool_name="get_skill_info",
        ),
        2: error_result(
            "boom",
            tool_name="demo_tool",
        ),
    }

    resolved = replace_placeholders(fake_agent, payload, agent_results)

    assert "demo-skill" in resolved["task"]
    assert "[Agent 2 执行失败: boom]" in resolved["task"]


def test_master_placeholder_supports_agent_metadata_child_agent_id_path():
    fake_agent = _FakeOrchestratorAgent()
    payload = {
        "message": "继续处理 {result_1.metadata.child_agent_id}",
    }
    agent_results = {
        1: success_result(
            content={"answer": "ok"},
            summary="ok",
            output_type="json",
            tool_name="call_agent",
            metadata={"child_agent_id": "child-123"},
        )
    }

    resolved = replace_placeholders(fake_agent, payload, agent_results)

    assert resolved["message"] == "继续处理 child-123"


def test_master_placeholder_supports_agent_execution_service_native_result():
    fake_agent = _FakeOrchestratorAgent()

    class _StubRuntimeService:
        def create_execution_orchestrator(self, session_id=None):
            del session_id
            return type(
                "_Orchestrator",
                (),
                {
                    "agents": {
                        "demo_agent": _StubDelegatedAgent(
                            AgentResponse(
                                success=True,
                                content={"name": "delegated-skill"},
                            )
                        )
                    }
                },
            )()

        def build_context(self, **kwargs):
            return AgentContext(session_id=kwargs["session_id"])

        def get_conversation_store(self):
            return type("_Store", (), {"create_run": lambda self, **kwargs: kwargs})()

    service = AgentExecutionService(runtime_service=_StubRuntimeService())
    delegated_result = service.execute_agent_call(
        agent_name="demo_agent",
        task="fetch skill",
        session_id="session-1",
        source='agent_call',
    )
    payload = {
        "task": "引用路径 {result_1.content.name}",
    }

    resolved = replace_placeholders(fake_agent, payload, {1: delegated_result})

    assert "delegated-skill" in resolved["task"]

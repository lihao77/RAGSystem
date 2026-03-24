# -*- coding: utf-8 -*-

import json
import logging

from agents.core import AgentContext, AgentResponse
from agents.implementations.orchestrator.executor import AgentExecutor
from agents.implementations.orchestrator.prompting import replace_placeholders
from agents.implementations.react.agent import ReActAgent
from tools.runtime.response_builder import error_result, success_result


class _FakeReActAgent:
    logger = logging.getLogger("test.react.placeholder")

    @staticmethod
    def _safe_json_dumps(obj):
        return json.dumps(obj, ensure_ascii=False)


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

    resolved = ReActAgent._resolve_tool_references(fake_agent, arguments, tool_results, current_idx=2)

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

    resolved = ReActAgent._resolve_tool_references(fake_agent, arguments, tool_results, current_idx=2)

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


def test_master_placeholder_supports_agent_executor_native_result():
    fake_agent = _FakeOrchestratorAgent()
    executor = AgentExecutor(
        orchestrator=type(
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
    )

    delegated_result = executor.execute_agent(
        agent_name="demo_agent",
        task="fetch skill",
        context=AgentContext(session_id="session-1"),
    )
    payload = {
        "task": "引用路径 {result_1.content.name}",
    }

    resolved = replace_placeholders(fake_agent, payload, {1: delegated_result})

    assert "delegated-skill" in resolved["task"]

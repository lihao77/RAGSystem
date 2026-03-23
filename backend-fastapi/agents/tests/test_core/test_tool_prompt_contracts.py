# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.core import BaseAgent
from agents.implementations.orchestrator import prompting as orchestrator_prompting
from agents.implementations.react.agent import ReActAgent, _format_tool_contract as react_format_tool_contract
from tools.auto_discovery import discover_decorated_tools
from tools.decorators import get_decorated_tools
from tools.tool_definition_builder import build_function_tool


discover_decorated_tools()


def _decorated_tool(name: str):
    contract = get_decorated_tools()[name]["contract"]
    return build_function_tool(contract)


def _fake_agent(**overrides):
    agent = SimpleNamespace(
        base_prompt="system",
        available_tools=[],
        available_skills=[],
        _format_skills_description=lambda: BaseAgent._format_skills_description(agent),
        _get_direct_tools_for_prompt=lambda: BaseAgent._get_direct_tools_for_prompt(agent),
        _build_direct_tools_section=lambda: BaseAgent._build_direct_tools_section(agent),
        _build_prompt_tool_call_example=lambda: BaseAgent._build_prompt_tool_call_example(agent),
        _build_agent_specific_prompt_sections=lambda: [],
        _get_available_agent_tools=lambda: [],
    )
    for key, value in overrides.items():
        setattr(agent, key, value)
    return agent


def test_react_format_tool_contract_uses_input_payload_and_filters_helper_fields():
    tool = {
        "function": {
            "name": "demo_tool",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                },
                "required": ["command"],
            },
            "examples": [
                {
                    "input": {"command": "pwd"},
                    "result_hint": {"stdout": "/tmp"},
                }
            ],
        }
    }

    lines = react_format_tool_contract(tool)
    rendered = "\n".join(lines)

    assert "<command>pwd</command>" in rendered
    assert "<input>" not in rendered
    assert "<!-- result_hint:" in rendered


def test_orchestrator_format_tool_contract_uses_input_payload_and_filters_helper_fields():
    func = {
        "name": "demo_tool",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
            },
            "required": ["command"],
        },
        "examples": [
            {
                "input": {"command": "pwd"},
                "result_hint": {"stdout": "/tmp"},
            }
        ],
    }

    lines = orchestrator_prompting._format_tool_contract(func)
    rendered = "\n".join(lines)

    assert "<command>pwd</command>" in rendered
    assert "<input>" not in rendered
    assert "<!-- result_hint:" in rendered


def test_tool_examples_can_render_xml_attrs_without_stringified_nested_tags():
    func = {
        "name": "write_file",
        "examples": [
            {
                "input": {
                    "content": "temporary text",
                    "file_path": "tmp.txt",
                },
                "xml_attrs": {
                    "file_path": {"space": "transient"},
                },
                "result_hint": {"display_path": "./data/sessions/<session_id>/transient/tmp.txt"},
            }
        ],
    }

    lines = BaseAgent._format_tool_contract(func)
    rendered = "\n".join(lines)

    assert '<file_path space="transient">tmp.txt</file_path>' in rendered
    assert '<![CDATA[<file_path space="transient">tmp.txt</file_path>]]>' not in rendered
    assert '<file_path_space>' not in rendered
    assert "<!-- xml_attrs:" not in rendered


def test_react_prompt_renders_space_examples_as_xml_attributes():
    from tools.catalog.document_tools import DOCUMENT_TOOLS

    write_file_tool = next(tool for tool in DOCUMENT_TOOLS if tool["function"]["name"] == "write_file")
    execute_bash_tool = _decorated_tool("execute_bash")
    fake_agent = _fake_agent(available_tools=[write_file_tool, execute_bash_tool])

    prompt = ReActAgent._build_system_prompt(fake_agent)

    assert '<file_path space="transient">tmp.txt</file_path>' in prompt
    assert '<file_path_space>transient</file_path_space>' not in prompt
    assert '<working_dir space="workspace">.</working_dir>' in prompt
    assert '<working_dir_space>workspace</working_dir_space>' not in prompt


def test_react_prompt_renders_read_and_edit_file_space_examples_as_xml_attributes():
    from tools.catalog.document_tools import DOCUMENT_TOOLS

    read_file_tool = next(tool for tool in DOCUMENT_TOOLS if tool["function"]["name"] == "read_file")
    edit_file_tool = next(tool for tool in DOCUMENT_TOOLS if tool["function"]["name"] == "edit_file")
    fake_agent = _fake_agent(available_tools=[read_file_tool, edit_file_tool])

    prompt = ReActAgent._build_system_prompt(fake_agent)

    assert '<file_path space="transient">tmp.txt</file_path>' in prompt
    assert '<file_path_space>transient</file_path_space>' not in prompt
    assert '<file_path space="workspace">note.txt</file_path>' in prompt
    assert '<file_path_space>workspace</file_path_space>' not in prompt


def test_react_build_system_prompt_includes_tool_return_contracts():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = ReActAgent._build_system_prompt(fake_agent)

    assert "### execute_skill_script" in prompt
    assert "**调用能力**:" in prompt
    assert "direct（可直接调用）" in prompt
    assert "## 工具调用总规则" in prompt
    assert "**成功返回**:" in prompt
    assert '"script_name": "string"' in prompt
    assert "**使用约束**:" in prompt
    assert "成功时返回脚本执行结果" in prompt
    assert "arguments 必须是字符串数组" in prompt
    assert "<final_answer>" in prompt
    assert "自然语言概括当前判断或下一步计划" in prompt
    assert "不要展开冗长推理" in prompt


def test_orchestrator_build_system_prompt_includes_direct_tool_return_contracts():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = BaseAgent._build_shared_system_prompt(fake_agent)

    assert "## 可直接调用的工具" in prompt
    assert "### execute_skill_script" in prompt
    assert "**调用能力**:" in prompt
    assert "direct（可直接调用）" in prompt
    assert "## 工具调用总规则" in prompt
    assert "**成功返回**:" in prompt
    assert '"script_name": "string"' in prompt
    assert "**使用约束**:" in prompt
    assert "成功时返回脚本执行结果" in prompt
    assert "arguments 必须是字符串数组" in prompt
    assert "<final_answer>" in prompt
    assert "自然语言概括当前判断或下一步计划" in prompt
    assert "不要展开冗长推理" in prompt


def test_react_prompt_includes_file_and_code_tool_contracts():
    from tools.catalog.document_tools import DOCUMENT_TOOLS

    read_file_tool = next(tool for tool in DOCUMENT_TOOLS if tool["function"]["name"] == "read_file")
    execute_code_tool = _decorated_tool("execute_code")
    fake_agent = _fake_agent(available_tools=[read_file_tool, execute_code_tool])

    prompt = ReActAgent._build_system_prompt(fake_agent)

    assert "## 工具调用总规则" in prompt
    assert "### read_file" in prompt
    assert "**调用能力**:" in prompt
    assert "direct（可直接调用）" in prompt
    assert "成功时返回文件内容和分页元数据" in prompt
    assert "file_path 必须是真实路径字符串" in prompt
    assert 'space="workspace"' in prompt
    assert 'space="transient"' in prompt
    assert 'space="exports"' in prompt
    assert "### execute_code" in prompt
    assert "**调用能力**:" in prompt
    assert "代码必须设置 result 变量作为最终输出" in prompt
    assert "需要调用工具时使用 call_tool(tool_name, arguments)" in prompt
    assert "### 受管目录 space 说明" in prompt


def test_react_prompt_includes_execute_bash_managed_location_contract():
    execute_bash_tool = _decorated_tool("execute_bash")
    fake_agent = _fake_agent(available_tools=[execute_bash_tool])

    prompt = ReActAgent._build_system_prompt(fake_agent)

    assert "### execute_bash" in prompt
    assert "**调用能力**:" in prompt
    assert "direct（可直接调用）" in prompt
    assert 'space="workspace"' in prompt
    assert 'space="transient"' in prompt
    assert 'space="exports"' in prompt
    assert "### 受管目录 space 说明" in prompt
    assert "默认工作目录为当前 effective workspace" in prompt
    assert "不再默认指向 backend-fastapi/" in prompt


def test_react_prompt_includes_skill_tool_contracts():
    activate_skill_tool = _decorated_tool("activate_skill")
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[activate_skill_tool, execute_skill_script_tool])

    prompt = ReActAgent._build_system_prompt(fake_agent)

    assert "### activate_skill" in prompt
    assert "成功时返回 Skill 主文件内容和基础信息" in prompt
    assert "返回的 main_content 就是 SKILL.md 正文" in prompt
    assert "### execute_skill_script" in prompt
    assert "成功时返回脚本执行结果" in prompt
    assert "arguments 必须是字符串数组" in prompt


def test_base_prompt_includes_execute_code_capability_section_when_tool_is_available():
    execute_code_tool = _decorated_tool("execute_code")
    fake_agent = _fake_agent(available_tools=[execute_code_tool])

    prompt = BaseAgent._build_shared_system_prompt(fake_agent)

    assert "## execute_code 中可调用的工具" in prompt
    assert "当前没有额外工具可从代码中调用" in prompt
    assert "`call_tool()` 只返回工具的主内容" in prompt
    assert "SESSION_WORKSPACE_DIR" in prompt
    assert "request_write_approval()" in prompt
    assert "未列出的工具不能从代码中调用" in prompt


def test_base_prompt_omits_execute_code_capability_section_without_execute_code_tool():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = BaseAgent._build_shared_system_prompt(fake_agent)

    assert "## execute_code 中可调用的工具" not in prompt


def test_react_and_orchestrator_share_prompt_skeleton_with_capability_and_type_extensions():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    execute_code_tool = _decorated_tool("execute_code")

    react_agent = _fake_agent(
        available_tools=[execute_skill_script_tool, execute_code_tool],
    )
    orchestrator_agent = _fake_agent(
        available_tools=[execute_skill_script_tool, execute_code_tool],
        _get_available_agent_tools=lambda: [
            {"function": {"name": "invoke_agent_chart_agent", "description": "调用图表智能体"}}
        ],
        _build_prompt_goal_section=lambda: "## 工作目标\n\n主编排器目标",
        _build_prompt_principles_section=lambda: "## 编排原则\n\n主编排器原则",
        _build_agent_specific_prompt_sections=lambda: orchestrator_prompting.build_orchestrator_specific_sections(orchestrator_agent),
    )

    react_prompt = ReActAgent._build_system_prompt(react_agent)
    orchestrator_prompt = BaseAgent._build_shared_system_prompt(orchestrator_agent)

    for marker in ["## 工具调用总规则", "## 可直接调用的工具", "## 输出格式", "## 执行规则", "### 受管目录 space 说明"]:
        assert marker in react_prompt
        assert marker in orchestrator_prompt

    assert "## execute_code 中可调用的工具" in react_prompt
    assert "## execute_code 中可调用的工具" in orchestrator_prompt
    assert "## 可用的 Agent 工具" in orchestrator_prompt
    assert "invoke_agent_chart_agent" in orchestrator_prompt
    assert "## 可用的 Agent 工具" not in react_prompt

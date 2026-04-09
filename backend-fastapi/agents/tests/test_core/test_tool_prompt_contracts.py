# -*- coding: utf-8 -*-

from types import SimpleNamespace

import pytest

from agents.core import BaseAgent
from agents.core import prompting as core_prompting
from agents.implementations.orchestrator import prompting as orchestrator_prompting
from tools.bootstrap import bootstrap_tool_system
from tools.decorators import get_decorated_tools
from tools.contracts.tool_contracts import build_function_tool
from tools.tool_registry import get_tool_registry

bootstrap_tool_system()


def _decorated_tool(name: str):
    contract = get_decorated_tools()[name]["contract"]
    return build_function_tool(contract)


def _tool_from_registry(name: str):
    registry = get_tool_registry()
    tool = registry.get_tool_by_name(name)
    assert tool is not None
    return tool


def _fake_agent(**overrides):
    agent = SimpleNamespace(
        base_prompt="system",
        available_tools=[],
        available_skills=[],
        agent_config=SimpleNamespace(
            delegation=SimpleNamespace(enabled_agents=[]),
        ),
        orchestrator=SimpleNamespace(agents={}),
        _format_skills_description=lambda: BaseAgent._format_skills_description(agent),
        _build_agent_specific_prompt_sections=lambda: [],
        _get_available_agent_tools=lambda: [],
        _build_prompt_hook=lambda method_name, *args: core_prompting._invoke_prompt_hook(agent, method_name, *args),
        _system_prompt_cache_key_extra=lambda: None,
    )
    for key, value in overrides.items():
        setattr(agent, key, value)
    return agent


class _PromptCacheTestAgent(BaseAgent):
    def __init__(self, name: str, base_prompt: str = "system"):
        super().__init__(name=name, description="test")
        self.base_prompt = base_prompt
        self.available_tools = []
        self.available_skills = []
        self.agent_config = SimpleNamespace(
            delegation=SimpleNamespace(enabled_agents=[]),
        )
        self.orchestrator = SimpleNamespace(agents={})

    def execute(self, task, context):
        raise NotImplementedError


def test_react_prompt_uses_claude_code_style_sections():
    fake_agent = _fake_agent()

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert 'You are RAGSystem, an interactive software engineering agent.' in prompt
    assert '## Doing tasks' in prompt
    assert '## Core principles' in prompt
    assert '## Executing actions with care' in prompt
    assert '## Using your tools' in prompt
    assert '## Output efficiency' in prompt


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

    lines = core_prompting.format_tool_contract(tool)
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

    lines = core_prompting.format_tool_contract(func)
    rendered = "\n".join(lines)

    assert '<file_path space="transient">tmp.txt</file_path>' in rendered
    assert '<![CDATA[<file_path space="transient">tmp.txt</file_path>]]>' not in rendered
    assert '<file_path_space>' not in rendered
    assert "<!-- xml_attrs:" not in rendered


def test_react_prompt_renders_space_examples_as_xml_attributes():
    write_file_tool = _tool_from_registry("write_file")
    execute_bash_tool = _decorated_tool("execute_bash")
    fake_agent = _fake_agent(available_tools=[write_file_tool, execute_bash_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert '<file_path space="transient">tmp.txt</file_path>' in prompt
    assert '<file_path_space>transient</file_path_space>' not in prompt
    assert '<working_dir space="workspace">.</working_dir>' in prompt
    assert '<working_dir_space>workspace</working_dir_space>' not in prompt


def test_react_prompt_renders_read_and_edit_file_space_examples_as_xml_attributes():
    read_file_tool = _tool_from_registry("read_file")
    edit_file_tool = _tool_from_registry("edit_file")
    fake_agent = _fake_agent(available_tools=[read_file_tool, edit_file_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert '<file_path space="transient">tmp.txt</file_path>' in prompt
    assert '<file_path_space>transient</file_path_space>' not in prompt
    assert '<file_path space="workspace">note.txt</file_path>' in prompt
    assert '<file_path_space>workspace</file_path_space>' not in prompt


def test_react_build_system_prompt_includes_tool_return_contracts():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

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
    assert "极短的当前意图" in prompt
    assert "不要写冗长推理、分析过程或额外过程汇报" in prompt


def test_orchestrator_build_system_prompt_includes_direct_tool_return_contracts():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

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


def test_react_prompt_includes_file_and_code_tool_contracts():
    read_file_tool = _tool_from_registry("read_file")
    execute_code_tool = _decorated_tool("execute_code")
    fake_agent = _fake_agent(available_tools=[read_file_tool, execute_code_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "### read_file" in prompt
    assert "### execute_code" in prompt
    assert "### 受管目录 space 说明" in prompt


def test_react_prompt_includes_execute_bash_managed_location_contract():
    execute_bash_tool = _decorated_tool("execute_bash")
    fake_agent = _fake_agent(available_tools=[execute_bash_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "### execute_bash" in prompt
    assert "默认工作目录为当前 effective workspace" in prompt
    assert "不再默认指向 backend-fastapi/" in prompt


def test_react_prompt_includes_skill_tool_contracts():
    activate_skill_tool = _decorated_tool("activate_skill")
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[activate_skill_tool, execute_skill_script_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "### activate_skill" in prompt
    assert "### execute_skill_script" in prompt


def test_prompt_cache_key_changes_when_tool_prompt_metadata_changes():
    tool_v1 = {
        "function": {
            "name": "demo_tool",
            "description": "first description",
            "parameters": {
                "type": "object",
                "properties": {"q": {"type": "string", "description": "query"}},
                "required": ["q"],
            },
            "allowed_callers": ["direct"],
            "returns": {"type": "string", "description": "plain text"},
            "usage_contract": ["keep short"],
            "examples": [{"input": {"q": "a"}}],
        }
    }
    tool_v2 = {
        "function": {
            **tool_v1["function"],
            "description": "second description",
        }
    }
    agent_v1 = _fake_agent(name="agent_v1", available_tools=[tool_v1])
    agent_v2 = _fake_agent(name="agent_v1", available_tools=[tool_v2])

    key_v1 = BaseAgent._system_prompt_cache_key(agent_v1)
    key_v2 = BaseAgent._system_prompt_cache_key(agent_v2)

    assert key_v1 != key_v2


def test_prompt_cache_key_changes_when_skill_description_changes():
    skill_v1 = SimpleNamespace(name="analysis", description="first")
    skill_v2 = SimpleNamespace(name="analysis", description="second")
    agent_v1 = _fake_agent(name="agent_v1", available_skills=[skill_v1])
    agent_v2 = _fake_agent(name="agent_v1", available_skills=[skill_v2])

    key_v1 = BaseAgent._system_prompt_cache_key(agent_v1)
    key_v2 = BaseAgent._system_prompt_cache_key(agent_v2)

    assert key_v1 != key_v2


def test_orchestrator_cache_key_extra_is_stable_for_same_roster_order():
    roster = [
        {
            "agent_name": "researcher",
            "display_name": "Researcher",
            "description": "do research",
            "use_cases": ["search"],
            "tool_count": 2,
        },
        {
            "agent_name": "coder",
            "display_name": "Coder",
            "description": "write code",
            "use_cases": ["implement"],
            "tool_count": 3,
        },
    ]

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(orchestrator_prompting, "_build_agent_roster", lambda agent: roster)
    try:
        extra_1 = orchestrator_prompting.get_orchestrator_cache_key_extra(SimpleNamespace())
        extra_2 = orchestrator_prompting.get_orchestrator_cache_key_extra(SimpleNamespace())
    finally:
        monkeypatch.undo()

    assert extra_1 == extra_2


def test_system_prompt_cache_uses_lru_eviction_on_cache_hit():
    original_cache = BaseAgent._system_prompt_cache
    original_max = BaseAgent._SYSTEM_PROMPT_CACHE_MAX
    BaseAgent._system_prompt_cache = BaseAgent._system_prompt_cache.__class__()
    BaseAgent._SYSTEM_PROMPT_CACHE_MAX = 2

    try:
        agent_a = _PromptCacheTestAgent(name="agent_a")
        agent_b = _PromptCacheTestAgent(name="agent_b")
        agent_c = _PromptCacheTestAgent(name="agent_c")

        prompt_a = agent_a._build_system_prompt()
        prompt_b = agent_b._build_system_prompt()
        prompt_a_again = agent_a._build_system_prompt()
        prompt_c = agent_c._build_system_prompt()

        assert prompt_a_again == prompt_a
        assert prompt_b
        assert prompt_c
        assert len(BaseAgent._system_prompt_cache) == 2
        assert agent_a._system_prompt_cache_key() in BaseAgent._system_prompt_cache
        assert agent_b._system_prompt_cache_key() not in BaseAgent._system_prompt_cache
        assert agent_c._system_prompt_cache_key() in BaseAgent._system_prompt_cache
    finally:
        BaseAgent._system_prompt_cache = original_cache
        BaseAgent._SYSTEM_PROMPT_CACHE_MAX = original_max


def test_base_prompt_includes_execute_code_capability_section_when_tool_is_available():
    execute_code_tool = _decorated_tool("execute_code")
    fake_agent = _fake_agent(available_tools=[execute_code_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "## execute_code 中可调用的工具" in prompt
    assert "当前没有额外工具可从代码中调用" in prompt


def test_prompt_only_renders_examples_for_whitelisted_complex_tools():
    read_file_tool = _tool_from_registry("read_file")
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[read_file_tool, execute_skill_script_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    read_file_section = prompt.split("### read_file", 1)[1].split("### execute_skill_script", 1)[0]
    skill_section = prompt.split("### execute_skill_script", 1)[1].split("## 工具调用总规则", 1)[0]

    assert "**示例**:" in read_file_section
    assert '<file_path space="transient">tmp.txt</file_path>' in read_file_section
    assert "**示例**:" not in skill_section


def test_execute_code_prompt_uses_neutral_call_tool_example():
    execute_code_tool = _decorated_tool("execute_code")
    fake_agent = _fake_agent(available_tools=[execute_code_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)
    code_section = prompt.split("## execute_code 中可调用的工具", 1)[1].split("## 子 Agent 委派", 1)[0] if "## 子 Agent 委派" in prompt else prompt.split("## execute_code 中可调用的工具", 1)[1]

    assert "call_tool('tool_name'" in code_section
    assert "assess_flood_risk" not in code_section
    assert "['content']" in code_section


    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "## execute_code 中可调用的工具" not in prompt


def test_prompt_shrinks_skill_descriptions_and_whitelisted_examples():
    activate_skill_tool = _decorated_tool("activate_skill")
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    execute_bash_tool = _decorated_tool("execute_bash")
    read_file_tool = _tool_from_registry("read_file")
    write_file_tool = _tool_from_registry("write_file")
    execute_code_tool = _decorated_tool("execute_code")
    fake_agent = _fake_agent(
        available_tools=[activate_skill_tool, execute_skill_script_tool, execute_bash_tool, read_file_tool, write_file_tool, execute_code_tool]
    )

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    activate_section = prompt.split("### activate_skill", 1)[1].split("### execute_skill_script", 1)[0]
    execute_skill_section = prompt.split("### execute_skill_script", 1)[1].split("### execute_bash", 1)[0]

    assert "每个任务通常只需激活一个 Skill" not in activate_section
    assert "调用格式" not in execute_skill_section
    assert prompt.count('<tool name="execute_bash">') == 2
    assert prompt.count('<tool name="read_file">') == 2
    assert prompt.count('<tool name="write_file">') == 2
    assert prompt.count('<tool name="execute_code">') == 1


    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "## System" in prompt
    assert "## Doing tasks" in prompt
    assert "## Executing actions with care" in prompt
    assert "## Using your tools" in prompt
    assert "先判断是否能直接回答" in prompt
    assert "结果足够支持答案时，必须停止继续调用并输出 `<final_answer>`" in prompt
    assert "不要无变化重复同一失败调用" in prompt
    assert "补参数、缩小范围、换工具、改为追问用户" in prompt
    assert "读取已有文件优先 `read_file`" in prompt
    assert "先读取相关内容并理解当前实现" in prompt
    assert "只做当前任务需要的最小修改" in prompt
    assert "高风险动作，要先确认再执行" in prompt
    assert "能一句说清就不要三句" in prompt

    assert prompt.index("## System") < prompt.index("## Doing tasks")
    assert prompt.index("## Doing tasks") < prompt.index("## Core principles")
    assert prompt.index("## Core principles") < prompt.index("## Executing actions with care")
    assert prompt.index("## Executing actions with care") < prompt.index("## Output efficiency")
    assert prompt.index("## Output efficiency") < prompt.index("## Using your tools")
    assert prompt.index("## Using your tools") < prompt.index("## 可直接调用的工具")
    assert prompt.index("## 可直接调用的工具") < prompt.index("## Skills")
    assert prompt.index("## Skills") < prompt.index("## 输出格式")
    assert prompt.index("## 输出格式") < prompt.index("## 执行规则")
    assert prompt.index("## 执行规则") < prompt.index("### 数据文件传递规则")


def test_base_prompt_uses_single_brace_result_placeholder_syntax():
    fake_agent = _fake_agent()

    prompt = core_prompting.build_shared_system_prompt(fake_agent)

    assert "链式调用用 {result_N} 引用同轮第 N 个工具结果" in prompt
    assert "{{result_N}}" not in prompt


def test_orchestrator_prompt_examples_use_call_agent_and_roster():
    chart_agent = SimpleNamespace(
        agent_config=SimpleNamespace(
            display_name="图表智能体",
            description="负责图表生成",
            custom_params={"behavior": {"use_cases": "图表与地图可视化"}},
        ),
        description="chart",
        available_tools=[{"function": {"name": "create_chart"}}],
    )
    orchestrator_agent = _fake_agent(
        available_tools=[_tool_from_registry("call_agent")],
        agent_config=SimpleNamespace(delegation=SimpleNamespace(enabled_agents=["chart_agent"])),
        orchestrator=SimpleNamespace(agents={"chart_agent": chart_agent}),
    )
    orchestrator_agent._build_prompt_goal_section = lambda: "## 工作目标\n\n主编排器目标"
    orchestrator_agent._build_prompt_principles_section = lambda: "## 编排原则\n\n主编排器原则"
    orchestrator_agent._build_agent_specific_prompt_sections = lambda: orchestrator_prompting.build_orchestrator_specific_sections(orchestrator_agent)

    prompt = core_prompting.build_shared_system_prompt(orchestrator_agent)

    assert "call_agent" in prompt
    assert "list_child_agents" in prompt
    assert "send_message" in prompt
    assert "chart_agent" in prompt
    assert "图表智能体" in prompt
    assert "图表与地图可视化" in prompt
    assert "只有在直接回答或直接工具不足以完成任务时，才委派子 Agent。优先顺序始终是：直答 > direct tool > 单子 Agent > 多 Agent。" in prompt
    assert "已有合适 `child_agent_id` 时优先用 `send_message(...)` 续接" in prompt
    assert "只有确实需要目标 Agent 专长或独立上下文时才委派" in prompt
    assert "下一次委派必须改变任务描述、范围、输入或目标" in prompt
    assert "invoke_agent_" not in prompt

    assert prompt.index("## 编排原则") < prompt.index("## 子 Agent 委派")
    assert prompt.index("## 子 Agent 委派") < prompt.index("### 当前可委派子 Agent 列表")
    assert prompt.index("### 当前可委派子 Agent 列表") < prompt.index("### 示例")
    assert prompt.index("### 示例") < prompt.index("### 数据文件传递规则")


def test_react_and_orchestrator_share_prompt_skeleton_with_capability_and_type_extensions():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    execute_code_tool = _decorated_tool("execute_code")
    call_agent_tool = _tool_from_registry("call_agent")
    chart_agent = SimpleNamespace(
        agent_config=SimpleNamespace(
            display_name="图表智能体",
            description="负责图表生成",
            custom_params={"behavior": {"use_cases": "图表与地图可视化"}},
        ),
        description="chart",
        available_tools=[{"function": {"name": "create_chart"}}],
    )

    react_agent = _fake_agent(available_tools=[execute_skill_script_tool, execute_code_tool])
    orchestrator_agent = _fake_agent(
        available_tools=[execute_skill_script_tool, execute_code_tool, call_agent_tool],
        agent_config=SimpleNamespace(delegation=SimpleNamespace(enabled_agents=["chart_agent"])),
        orchestrator=SimpleNamespace(agents={"chart_agent": chart_agent}),
        _build_prompt_goal_section=lambda: "## 工作目标\n\n主编排器目标",
        _build_prompt_principles_section=lambda: "## 编排原则\n\n主编排器原则",
    )
    orchestrator_agent._build_agent_specific_prompt_sections = lambda: orchestrator_prompting.build_orchestrator_specific_sections(orchestrator_agent)

    react_prompt = core_prompting.build_shared_system_prompt(react_agent)
    orchestrator_prompt = core_prompting.build_shared_system_prompt(orchestrator_agent)

    for marker in ["## Using your tools", "## 工具调用总规则", "## 可直接调用的工具", "## 输出格式", "## 执行规则", "### 受管目录 space 说明"]:
        assert marker in react_prompt
        assert marker in orchestrator_prompt

    assert "## execute_code 中可调用的工具" in react_prompt
    assert "## execute_code 中可调用的工具" in orchestrator_prompt
    assert "## 当前可委派子 Agent 列表" in orchestrator_prompt
    assert "call_agent" in orchestrator_prompt
    assert "list_child_agents" in orchestrator_prompt
    assert "send_message" in orchestrator_prompt
    assert "## 当前可委派子 Agent 列表" not in react_prompt


def test_shared_prompting_module_matches_base_agent_system_prompt_entry():
    execute_skill_script_tool = _decorated_tool("execute_skill_script")
    fake_agent = _fake_agent(available_tools=[execute_skill_script_tool])

    assert BaseAgent._build_system_prompt(fake_agent) == core_prompting.build_shared_system_prompt(fake_agent)
    assert core_prompting.build_direct_tools_section(fake_agent) in core_prompting.build_shared_system_prompt(fake_agent)
    assert core_prompting.format_tool_contract(execute_skill_script_tool)

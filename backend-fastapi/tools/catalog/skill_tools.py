# -*- coding: utf-8 -*-
"""Skill system tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tools


SKILL_TOOL_CONTRACTS = [
    ToolContract(
        name="activate_skill",
        description=(
            "激活一个 Skill 并加载其主文件内容（SKILL.md）。\n\n"
            "**使用时机**：\n"
            "- 当你判断用户任务匹配某个 Skill 的适用场景时，首先激活该 Skill\n"
            "- 激活后你将获得该 Skill 的完整指导流程和工作方法\n\n"
            "**效果**：\n"
            "- 加载 SKILL.md 主文件内容\n"
            "- 系统记录该 Skill 已激活，便于上下文管理\n"
            "- 返回 Skill 的完整指导内容\n\n"
            "**后续操作**：\n"
            "- 根据主文件中的提示，使用 `load_skill_resource` 加载详细文档\n"
            "- 根据主文件中的指示，使用 `execute_skill_script` 执行脚本\n\n"
            "**重要**：每个任务通常只需激活一个 Skill。"
            "如果需要切换到不同的 Skill，再次调用此工具。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "要激活的 Skill 名称，例如：'disaster-report-example'"
                }
            },
            "required": ["skill_name"]
        },
        returns={
            "type": "object",
            "description": "成功时返回 Skill 主文件内容和基础信息",
            "shape": {
                "skill_name": "string",
                "description": "string",
                "main_content": "string"
            }
        },
        usage_contract=[
            "activate_skill 通常是使用 Skill 的第一步",
            "返回的 main_content 就是 SKILL.md 正文，可直接按其中流程继续执行",
            "若主文件提到额外资源，再调用 load_skill_resource",
            "若主文件要求执行脚本，再调用 execute_skill_script"
        ],
        examples=[
            {
                "input": {
                    "skill_name": "kg-advanced-query"
                },
                "result_hint": {
                    "skill_name": "kg-advanced-query",
                    "main_content": "# Skill instructions ..."
                }
            }
        ],
        source="skill",
    ),
    ToolContract(
        name="load_skill_resource",
        description=(
            "加载 Skill 的引用文件内容（Additional Resources）。\n\n"
            "**前置条件**：\n"
            "- 你需要先使用 `activate_skill` 激活 Skill\n"
            "- 然后根据主文件（SKILL.md）中的提示，加载详细的引用文件\n\n"
            "**使用场景**：\n"
            "- 当主文件提到某个引用文件时（如 [report-template.md](report-template.md)）\n"
            "- 需要查看详细的模板、指南、示例等\n\n"
            "**重要**：此工具用于加载**额外的引用文件**，不是主文件。"
            "主文件通过 `activate_skill` 加载。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Skill 名称"
                },
                "resource_file": {
                    "type": "string",
                    "description": "要加载的引用文件名，例如：'report-template.md'、'advanced-analysis.md'"
                }
            },
            "required": ["skill_name", "resource_file"]
        },
        returns={
            "type": "object",
            "description": "成功时返回指定资源文件的内容",
            "shape": {
                "file_name": "string",
                "content": "string",
                "skill": "string"
            }
        },
        usage_contract=[
            "load_skill_resource 用于加载 activate_skill 主文件里提到的补充文档",
            "resource_file 应使用主文件中出现的相对文件名",
            "加载后的 content 可直接作为后续执行依据"
        ],
        examples=[
            {
                "input": {
                    "skill_name": "demo-skill",
                    "resource_file": "reference.md"
                },
                "result_hint": {
                    "file_name": "reference.md",
                    "content": "resource body"
                }
            }
        ],
        source="skill",
    ),
    ToolContract(
        name="execute_skill_script",
        description=(
            "执行 Skill 的实用脚本（零上下文执行）。"
            "只返回脚本的输出结果，不加载代码到上下文。\n\n"
            "**调用格式**：skill_name、script_name、arguments 必须作为独立的 JSON 字段传入，例如：\n"
            "{\"skill_name\": \"kg-advanced-query\", \"script_name\": \"query.py\", "
            "\"arguments\": [\"--cypher\", \"MATCH (n) RETURN n\"]}\n\n"
            "**错误示例**（禁止）：不要把参数序列化成字符串放进 arguments 数组。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Skill 名称"
                },
                "script_name": {
                    "type": "string",
                    "description": "脚本文件名，例如：'validate_data.py'"
                },
                "arguments": {
                    "type": "array",
                    "description": (
                        "传递给脚本的命令行参数列表，每个参数单独一个字符串元素，"
                        "例如：[\"--param\", \"值\"]"
                    ),
                    "items": {"type": "string"}
                }
            },
            "required": ["skill_name", "script_name"]
        },
        returns={
            "type": "object",
            "description": "成功时返回脚本执行结果",
            "shape": {
                "script_name": "string",
                "stdout": "string",
                "stderr": "string",
                "return_code": "number",
                "skill": "string"
            }
        },
        usage_contract=[
            "arguments 必须是字符串数组，每个命令行参数单独一个元素",
            "不要把整段 JSON 调用体序列化后塞进 arguments",
            "优先根据 activate_skill 返回的主文件说明选择脚本和参数",
            "return_code 为 0 通常表示成功"
        ],
        examples=[
            {
                "input": {
                    "skill_name": "kg-advanced-query",
                    "script_name": "query.py",
                    "arguments": [
                        "--cypher",
                        "MATCH (s:State) WHERE s.id CONTAINS $name RETURN s.id LIMIT 10",
                        "--params",
                        "{\"name\": \"潘厂水库\"}"
                    ]
                }
            }
        ],
        source="skill",
    ),
    ToolContract(
        name="get_skill_info",
        description=(
            "获取某个 Skill 的基础信息，不加载主文件内容。\n\n"
            "**使用场景**：\n"
            "- 先确认某个 Skill 是否存在\n"
            "- 查看 Skill 的描述、资源数量、是否带脚本\n"
            "- 在正式激活前做轻量探查"
        ),
        parameters={
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Skill 名称"
                }
            },
            "required": ["skill_name"]
        },
        returns={
            "type": "object",
            "description": "成功时返回 Skill 的轻量元信息",
            "shape": {
                "name": "string",
                "description": "string",
                "has_scripts": "boolean"
            }
        },
        usage_contract=[
            "get_skill_info 只做轻量探查，不会加载 SKILL.md 正文",
            "适合先确认 Skill 是否存在、是否带脚本、资源数量等",
            "若确定要使用该 Skill，再调用 activate_skill"
        ],
        examples=[
            {
                "input": {
                    "skill_name": "demo-skill"
                },
                "result_hint": {
                    "name": "demo-skill",
                    "has_scripts": True
                }
            }
        ],
        source="skill",
    ),
]


SKILLS_SYSTEM_TOOLS = build_function_tools(SKILL_TOOL_CONTRACTS)
SKILLS_TOOL_NAMES = {tool["function"]["name"] for tool in SKILLS_SYSTEM_TOOLS}

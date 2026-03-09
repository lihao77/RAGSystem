# -*- coding: utf-8 -*-
"""
Agent 内置工具定义（框架级，默认注入，不走 enabled_tools 配置过滤）

分两类：
1. REQUEST_USER_INPUT_TOOL — Human-in-the-Loop 补充输入，ReAct/Master 均注入
2. SKILLS_SYSTEM_TOOLS     — Skills 激活/加载/执行，启用了 Skills 的 Agent 才注入
"""

# ── 1. Human-in-the-Loop：向用户请求补充信息 ─────────────────────────────────

REQUEST_USER_INPUT_TOOL = {
    "type": "function",
    "function": {
        "name": "request_user_input",
        "description": (
            "当你需要用户提供额外信息才能继续完成任务时使用此工具。"
            "调用后系统会暂停执行并向用户展示输入对话框，等待用户填写后继续。\n\n"
            "**适用场景**：\n"
            "- 任务描述不完整，缺少关键参数（如文件路径、目标名称）\n"
            "- 需要用户从多个选项中选择一个处理方向\n"
            "- 需要用户确认某个假设再继续\n\n"
            "**不适用场景**：\n"
            "- 你已有足够信息可以完成任务\n"
            "- 可以通过工具查询获得所需信息\n"
            "- 仅需要用户审批（高风险工具会自动触发审批，无需此工具）"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "向用户展示的问题或说明，应清晰描述需要什么信息"
                },
                "input_type": {
                    "type": "string",
                    "enum": ["text", "select"],
                    "description": (
                        "输入类型：'text' 让用户自由输入文本；"
                        "'select' 从预设选项中选择（需同时提供 options）"
                    )
                },
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "当 input_type='select' 时提供的选项列表，例如：['选项A', '选项B', '选项C']"
                }
            },
            "required": ["prompt"]
        }
    }
}

# ── 2. Skills 系统工具（启用了 Skills 的 Agent 才注入）─────────────────────────

SKILLS_SYSTEM_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "activate_skill",
            "description": (
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
            "parameters": {
                "type": "object",
                "properties": {
                    "skill_name": {
                        "type": "string",
                        "description": "要激活的 Skill 名称，例如：'disaster-report-example'"
                    }
                },
                "required": ["skill_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "load_skill_resource",
            "description": (
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
            "parameters": {
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
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_skill_script",
            "description": (
                "执行 Skill 的实用脚本（零上下文执行）。"
                "只返回脚本的输出结果，不加载代码到上下文。\n\n"
                "**调用格式**：skill_name、script_name、arguments 必须作为独立的 JSON 字段传入，例如：\n"
                "{\"skill_name\": \"kg-advanced-query\", \"script_name\": \"query.py\", "
                "\"arguments\": [\"--cypher\", \"MATCH (n) RETURN n\"]}\n\n"
                "**错误示例**（禁止）：不要把参数序列化成字符串放进 arguments 数组。"
            ),
            "parameters": {
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
                "required": ["skill_name", "script_name"],
                "examples": [
                    {
                        "skill_name": "kg-advanced-query",
                        "script_name": "query.py",
                        "arguments": [
                            "--cypher",
                            "MATCH (s:State) WHERE s.id CONTAINS $name RETURN s.id LIMIT 10",
                            "--params", "{\"name\": \"潘厂水库\"}"
                        ]
                    }
                ]
            }
        }
    }
]

# ── 工具名集合（供路由判断用）──────────────────────────────────────────────────

BUILTIN_TOOL_NAMES = {REQUEST_USER_INPUT_TOOL['function']['name']}

SKILLS_TOOL_NAMES = {
    tool['function']['name'] for tool in SKILLS_SYSTEM_TOOLS
}

# ── 注入辅助函数 ───────────────────────────────────────────────────────────────

def get_builtin_tools_for_react(base_tools: list) -> list:
    """
    为 ReActAgent 组装工具列表：在 base_tools 末尾追加 request_user_input。
    已存在则不重复添加。
    """
    existing = {t['function']['name'] for t in base_tools}
    result = list(base_tools)
    if REQUEST_USER_INPUT_TOOL['function']['name'] not in existing:
        result.append(REQUEST_USER_INPUT_TOOL)
    return result


def get_builtin_tools_for_master(base_tools: list) -> list:
    """
    为 MasterAgentV2 组装工具列表：在 base_tools 末尾追加 request_user_input。
    已存在则不重复添加。
    Skills 工具由 AgentLoader._resolve_tools_and_skills 按配置注入，此处不重复追加。
    """
    existing = {t['function']['name'] for t in base_tools}
    result = list(base_tools)
    if REQUEST_USER_INPUT_TOOL['function']['name'] not in existing:
        result.append(REQUEST_USER_INPUT_TOOL)
    return result

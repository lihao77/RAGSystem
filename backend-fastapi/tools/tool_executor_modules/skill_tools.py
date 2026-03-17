# -*- coding: utf-8 -*-
"""
skill_tools 工具模块。
"""

import json
import logging
from .shared import error_result, success_result
from tools.decorators import tool
from tools.permissions import RiskLevel

logger = logging.getLogger(__name__)


def _parse_json_stdout(stdout):
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _unwrap_script_response(payload):
    """Unwrap common success/data envelopes emitted by skill scripts."""
    if not isinstance(payload, dict):
        return payload, None, {}

    if "success" not in payload or "data" not in payload:
        return payload, None, {}

    success = payload.get("success")
    if success is False:
        error_message = (
            payload.get("error")
            or payload.get("message")
            or payload.get("summary")
            or "脚本返回失败结果"
        )
        return None, str(error_message), {}

    metadata = {}
    for key in ("message", "summary", "count", "total", "offset", "limit"):
        value = payload.get(key)
        if value is not None:
            metadata[key] = value

    extra_metadata = payload.get("metadata")
    if isinstance(extra_metadata, dict):
        metadata.update(extra_metadata)

    return payload.get("data"), None, metadata

@tool(
    name="activate_skill",
    source="skill",
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
                "description": "要激活的 Skill 名称，例如：'disaster-report-example'",
            }
        },
        "required": ["skill_name"],
    },
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    timeout_seconds=60,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回 Skill 主文件内容和基础信息",
        "shape": {
            "skill_name": "string",
            "description": "string",
            "main_content": "string",
        },
    },
    usage_contract=[
        "activate_skill 通常是使用 Skill 的第一步",
        "返回的 main_content 就是 SKILL.md 正文，可直接按其中流程继续执行",
        "若主文件提到额外资源，再调用 load_skill_resource",
        "若主文件要求执行脚本，再调用 execute_skill_script",
    ],
    examples=[
        {
            "input": {"skill_name": "kg-advanced-query"},
            "result_hint": {
                "skill_name": "kg-advanced-query",
                "main_content": "# Skill instructions ...",
            },
        }
    ],
)
def activate_skill(skill_name):
    """
    激活一个 Skill 并加载其主文件内容（SKILL.md）

    这是使用 Skill 的第一步。激活后，AI 将获得该 Skill 的完整指导流程。

    Args:
        skill_name: 要激活的 Skill 名称

    Returns:
        Skill 的主文件内容和元数据

    功能：
    1. 加载 SKILL.md 主文件内容
    2. 记录 Skill 激活状态（未来用于上下文管理）
    3. 返回可用的引用文件和脚本列表
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 获取 Skill
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        skill = next((s for s in all_skills if s.name == skill_name), None)

        if not skill:
            available_skills = [s.name for s in all_skills]
            return error_result(
                f"Skill '{skill_name}' 不存在。可用的 Skills: {available_skills}",
                tool_name="activate_skill",
            )

        # 加载主文件内容（SKILL.md）
        main_content = skill.content

        logger.info(f"✅ 激活 Skill: {skill_name}")

        # 返回激活信息（无需提前列出资源和脚本）
        return success_result(
            content={
                "skill_name": skill_name,
                "description": skill.description,
                "main_content": main_content  # SKILL.md 的完整内容
            },
            metadata={
                "content_length": len(main_content),
                "activation_time": "now",  # 未来可以记录时间戳
                "status": "activated"
            },
            summary=f"✅ Skill '{skill_name}' 已激活，加载主文件 {len(main_content)} 字符",
            output_type="markdown",
            tool_name="activate_skill",
        )

    except Exception as e:
        logger.error(f"激活 Skill 失败: {e}")
        import traceback
        traceback.print_exc()
        return error_result(f"激活失败: {str(e)}", tool_name="activate_skill")

@tool(
    name="load_skill_resource",
    source="skill",
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
                "description": "Skill 名称",
            },
            "resource_file": {
                "type": "string",
                "description": "要加载的引用文件名，例如：'report-template.md'、'advanced-analysis.md'",
            },
        },
        "required": ["skill_name", "resource_file"],
    },
    risk_level=RiskLevel.MEDIUM,
    requires_approval=False,
    timeout_seconds=60,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回指定资源文件的内容",
        "shape": {
            "file_name": "string",
            "content": "string",
            "skill": "string",
        },
    },
    usage_contract=[
        "load_skill_resource 用于加载 activate_skill 主文件里提到的补充文档",
        "resource_file 应使用主文件中出现的相对文件名",
        "加载后的 content 可直接作为后续执行依据",
    ],
    examples=[
        {
            "input": {
                "skill_name": "demo-skill",
                "resource_file": "reference.md",
            },
            "result_hint": {
                "file_name": "reference.md",
                "content": "resource body",
            },
        }
    ],
)
def load_skill_resource(skill_name, resource_file):
    """
    加载 Skill 的引用文件内容（Additional Resources）

    实现渐进式披露：主 SKILL.md 保持简洁，详细内容按需加载

    Args:
        skill_name: Skill 名称
        resource_file: 要加载的文件名（相对于 Skill 目录）

    Returns:
        文件内容
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 获取 Skill
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        skill = next((s for s in all_skills if s.name == skill_name), None)

        if not skill:
            return error_result(f"Skill '{skill_name}' 不存在", tool_name="load_skill_resource")

        # 加载文件内容
        content = skill.get_resource_file_content(resource_file)

        if content is None:
            return error_result(
                f"文件 '{resource_file}' 不存在或无法读取",
                tool_name="load_skill_resource",
            )

        logger.info(f"加载 Skill 资源: {skill_name}/{resource_file} ({len(content)} 字符)")

        return success_result(
            content={
                "file_name": resource_file,
                "content": content,
                "skill": skill_name
            },
            metadata={
                "length": len(content)
            },
            summary=f"成功加载 {resource_file} ({len(content)} 字符)",
            output_type="markdown",
            tool_name="load_skill_resource",
        )

    except Exception as e:
        logger.error(f"加载 Skill 资源失败: {e}")
        import traceback
        traceback.print_exc()
        return error_result(f"加载失败: {str(e)}", tool_name="load_skill_resource")

@tool(
    name="execute_skill_script",
    source="skill",
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
                "description": "Skill 名称",
            },
            "script_name": {
                "type": "string",
                "description": "脚本文件名，例如：'validate_data.py'",
            },
            "arguments": {
                "type": "array",
                "description": (
                    "传递给脚本的命令行参数列表，每个参数单独一个字符串元素，"
                    "例如：[\"--param\", \"值\"]"
                ),
                "items": {"type": "string"},
            },
        },
        "required": ["skill_name", "script_name"],
    },
    risk_level=RiskLevel.MEDIUM,
    requires_approval=False,
    timeout_seconds=120,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回脚本执行结果",
        "shape": {
            "script_name": "string",
            "stdout": "string",
            "stderr": "string",
            "return_code": "number",
            "skill": "string",
        },
    },
    usage_contract=[
        "arguments 必须是字符串数组，每个命令行参数单独一个元素",
        "不要把整段 JSON 调用体序列化后塞进 arguments",
        "优先根据 activate_skill 返回的主文件说明选择脚本和参数",
        "return_code 为 0 通常表示成功",
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
                    '{"name": "潘厂水库"}',
                ],
            }
        }
    ],
)
def execute_skill_script(skill_name, script_name, arguments=None):
    """
    执行 Skill 的实用脚本（Utility Scripts）

    零上下文执行：脚本内容不加载到上下文，只返回执行结果

    ✨ 新特性：支持依赖隔离
    - 每个 Skill 可以有独立的虚拟环境
    - 自动安装 requirements.txt 中的依赖
    - 避免污染后端系统环境

    Args:
        skill_name: Skill 名称
        script_name: 脚本文件名
        arguments: 传递给脚本的命令行参数列表

    Returns:
        脚本执行结果（stdout, stderr, return_code）
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        # 获取 Skill
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        skill = next((s for s in all_skills if s.name == skill_name), None)

        if not skill:
            return error_result(f"Skill '{skill_name}' 不存在", tool_name="execute_skill_script")

        # 检查是否有 scripts 目录
        if not skill.has_scripts():
            return error_result(
                f"Skill '{skill_name}' 没有 scripts 目录",
                tool_name="execute_skill_script",
            )

        # 🔧 使用 Skill 的 execute_script 方法（支持环境隔离）
        script_args = arguments if arguments else []
        logger.info(f"执行 Skill 脚本: {skill_name}/{script_name} {script_args}")

        result = skill.execute_script(
            script_name=script_name,
            arguments=script_args,
            timeout=30
        )

        logger.info(f"脚本执行完成，返回码: {result['return_code']}")

        # 构建 metadata，大输出自动强制落盘
        meta = {"success": result['return_code'] == 0}
        stdout = result['stdout']
        stderr = result['stderr']
        if len(stdout) > 4000:
            meta["force_artifact"] = True

        parsed_stdout = None
        if result['return_code'] == 0:
            parsed_stdout = _parse_json_stdout(stdout)

        if parsed_stdout is not None:
            parsed_stdout, payload_error, payload_meta = _unwrap_script_response(parsed_stdout)
            if payload_error:
                return error_result(payload_error, tool_name="execute_skill_script")

            meta["script_name"] = script_name
            meta["skill"] = skill_name
            meta.update(payload_meta)
            if stderr.strip():
                meta["stderr"] = stderr

            return success_result(
                content=parsed_stdout,
                summary=f"脚本 {script_name} 执行完成（返回结构化 JSON）",
                metadata=meta,
                output_type="json",
                tool_name="execute_skill_script",
            )

        return success_result(
            content={
                "script_name": script_name,
                "stdout": stdout,
                "stderr": stderr,
                "return_code": result['return_code'],
                "skill": skill_name
            },
            summary=f"脚本 {script_name} 执行完成（返回码: {result['return_code']}）",
            metadata=meta,
            output_type="text",
            tool_name="execute_skill_script",
        )

    except Exception as e:
        logger.error(f"执行 Skill 脚本失败: {e}")
        import traceback
        traceback.print_exc()
        return error_result(f"执行失败: {str(e)}", tool_name="execute_skill_script")


@tool(
    name="get_skill_info",
    source="skill",
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
                "description": "Skill 名称",
            }
        },
        "required": ["skill_name"],
    },
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    timeout_seconds=60,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回 Skill 的轻量元信息",
        "shape": {
            "name": "string",
            "description": "string",
            "has_scripts": "boolean",
        },
    },
    usage_contract=[
        "get_skill_info 只做轻量探查，不会加载 SKILL.md 正文",
        "适合先确认 Skill 是否存在、是否带脚本、资源数量等",
        "若确定要使用该 Skill，再调用 activate_skill",
    ],
    examples=[
        {
            "input": {"skill_name": "demo-skill"},
            "result_hint": {
                "name": "demo-skill",
                "has_scripts": True,
            },
        }
    ],
)
def get_skill_info(skill_name: str):
    """
    获取 Skill 元信息。

    仅解析 SKILL.md 的 front matter，不加载正文内容，便于低成本预检。
    """
    try:
        from agents.skills.skill_loader import get_skill_loader

        skill_loader = get_skill_loader()
        skill_info = skill_loader.find_skill_metadata(skill_name)

        if not skill_info:
            return error_result(
                f"Skill '{skill_name}' 不存在",
                tool_name="get_skill_info",
                metadata={"available_skills": skill_loader.list_skill_names()},
            )

        skill_dir = skill_info["skill_dir"]
        return success_result(
            content={
                "name": skill_info["name"],
                "description": skill_info["description"],
                "has_scripts": (skill_dir / "scripts").is_dir(),
            },
            metadata={
                "resource_count": skill_loader.count_skill_resources(skill_dir),
            },
            summary=f"获取 Skill '{skill_name}' 信息成功",
            output_type="json",
            tool_name="get_skill_info",
        )

    except Exception as e:
        logger.error(f"获取 Skill 信息失败: {e}")
        return error_result(f"获取失败: {str(e)}", tool_name="get_skill_info")

# -*- coding: utf-8 -*-
"""
skill_tools 工具模块。
"""

import logging
from .shared import error_response, success_response

logger = logging.getLogger(__name__)

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
            return error_response(
                f"Skill '{skill_name}' 不存在。可用的 Skills: {available_skills}"
            )

        # 加载主文件内容（SKILL.md）
        main_content = skill.content

        logger.info(f"✅ 激活 Skill: {skill_name}")

        # 返回激活信息（无需提前列出资源和脚本）
        return success_response(
            results={
                "skill_name": skill_name,
                "description": skill.description,
                "main_content": main_content  # SKILL.md 的完整内容
            },
            metadata={
                "content_length": len(main_content),
                "activation_time": "now",  # 未来可以记录时间戳
                "status": "activated"
            },
            summary=f"✅ Skill '{skill_name}' 已激活，加载主文件 {len(main_content)} 字符"
        )

    except Exception as e:
        logger.error(f"激活 Skill 失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"激活失败: {str(e)}")

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
            return error_response(f"Skill '{skill_name}' 不存在")

        # 加载文件内容
        content = skill.get_resource_file_content(resource_file)

        if content is None:
            return error_response(
                f"文件 '{resource_file}' 不存在或无法读取"
            )

        logger.info(f"加载 Skill 资源: {skill_name}/{resource_file} ({len(content)} 字符)")

        return success_response(
            results={
                "file_name": resource_file,
                "content": content,
                "skill": skill_name
            },
            metadata={
                "length": len(content)
            },
            summary=f"成功加载 {resource_file} ({len(content)} 字符)"
        )

    except Exception as e:
        logger.error(f"加载 Skill 资源失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"加载失败: {str(e)}")

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
            return error_response(f"Skill '{skill_name}' 不存在")

        # 检查是否有 scripts 目录
        if not skill.has_scripts():
            return error_response(
                f"Skill '{skill_name}' 没有 scripts 目录"
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

        return success_response(
            results={
                "script_name": script_name,
                "stdout": result['stdout'],
                "stderr": result['stderr'],
                "return_code": result['return_code'],
                "skill": skill_name
            },
            summary=f"脚本 {script_name} 执行完成（返回码: {result['return_code']}）",
            metadata={
                "success": result['return_code'] == 0
            }
        )

    except Exception as e:
        logger.error(f"执行 Skill 脚本失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"执行失败: {str(e)}")

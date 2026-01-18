# -*- coding: utf-8 -*-
"""
Skill 加载器 - 支持 Claude Skills 核心特性

功能：
1. 解析 SKILL.md 的 name 和 description
2. 支持 Additional resources（按需加载引用文件）
3. 支持 Utility scripts（零上下文执行）
"""

import os
import re
import logging
from pathlib import Path
from typing import List, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


class Skill:
    """Skill 数据类"""

    def __init__(
        self,
        name: str,
        description: str,
        content: str,
        skill_dir: Path,
        metadata: Dict = None
    ):
        self.name = name
        self.description = description
        self.content = content  # Markdown 内容（不含 YAML 前置部分）
        self.skill_dir = skill_dir  # Skill 目录路径
        self.metadata = metadata or {}

    def get_resource_file_content(self, file_name: str) -> Optional[str]:
        """
        按需加载资源文件内容

        AI 从主文件中看到引用的文件名，然后调用此方法加载。
        无需提前解析和列出所有文件。

        Args:
            file_name: 相对于 Skill 目录的文件名

        Returns:
            文件内容，如果文件不存在返回 None
        """
        file_path = self.skill_dir / file_name

        if not file_path.exists():
            logger.warning(f"资源文件不存在: {file_path}")
            return None

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            logger.info(f"加载资源文件: {file_name} ({len(content)} 字符)")
            return content
        except Exception as e:
            logger.error(f"读取资源文件失败 {file_path}: {e}")
            return None

    def get_script_path(self, script_name: str) -> Optional[Path]:
        """
        获取脚本的完整路径

        AI 从主文件中看到要执行的脚本名，然后调用此方法获取路径。
        无需提前扫描 scripts/ 目录。

        Args:
            script_name: 脚本名称（如 "validate.py"）

        Returns:
            脚本的绝对路径，如果不存在返回 None
        """
        script_path = self.skill_dir / "scripts" / script_name

        if script_path.exists():
            return script_path.absolute()

        logger.warning(f"脚本不存在: {script_path}")
        return None

    def to_dict(self) -> Dict:
        """转换为字典格式（用于序列化）"""
        return {
            'name': self.name,
            'description': self.description,
            'content_length': len(self.content),
            'metadata': self.metadata
        }


class SkillLoader:
    """Skill 加载器"""

    def __init__(self, skills_dir: str = None):
        if skills_dir is None:
            # 默认路径：backend/agents/skills/
            skills_dir = Path(__file__).parent
        self.skills_dir = Path(skills_dir)
        logger.info(f"SkillLoader 初始化，Skills 目录: {self.skills_dir}")

    def load_all_skills(self) -> List[Skill]:
        """
        加载所有 Skills

        扫描 skills 目录下的所有子目录，查找 SKILL.md 文件
        """
        skills = []

        if not self.skills_dir.exists():
            logger.warning(f"Skills 目录不存在: {self.skills_dir}")
            return skills

        for skill_dir in self.skills_dir.iterdir():
            if skill_dir.is_dir() and not skill_dir.name.startswith('.'):
                skill_file = skill_dir / "SKILL.md"
                if skill_file.exists():
                    skill = self._parse_skill_file(skill_file, skill_dir)
                    if skill:
                        skills.append(skill)
                        logger.info(f"✓ 加载 Skill: {skill.name}")

        logger.info(f"共加载 {len(skills)} 个 Skills")
        return skills

    def _parse_skill_file(self, file_path: Path, skill_dir: Path) -> Optional[Skill]:
        """
        解析 SKILL.md 文件

        格式：
        ---
        name: skill-name
        description: Skill description here
        ---

        # Markdown content...
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # 分离 YAML front matter 和 Markdown 内容
            if not content.startswith('---'):
                logger.error(f"SKILL.md 缺少 YAML 前置部分: {file_path}")
                return None

            parts = content.split('---', 2)
            if len(parts) < 3:
                logger.error(f"SKILL.md 格式错误: {file_path}")
                return None

            # 解析 YAML（简单的键值对解析，避免依赖 PyYAML）
            yaml_content = parts[1].strip()
            metadata = self._parse_simple_yaml(yaml_content)

            # 提取必需字段
            name = metadata.get('name')
            description = metadata.get('description')

            if not name or not description:
                logger.error(f"SKILL.md 缺少必需字段 (name/description): {file_path}")
                return None

            markdown_content = parts[2].strip()

            return Skill(
                name=name,
                description=description,
                content=markdown_content,
                skill_dir=skill_dir,
                metadata=metadata
            )

        except Exception as e:
            logger.error(f"解析 SKILL.md 失败 {file_path}: {e}", exc_info=True)
            return None

    def _parse_simple_yaml(self, yaml_str: str) -> Dict:
        """
        简单的 YAML 解析器（仅支持键值对）

        支持格式：
        name: value
        description: multi-line value
                     continued here
        """
        result = {}
        lines = yaml_str.split('\n')

        current_key = None
        current_value = []

        for line in lines:
            # 检查是否是新的键值对（格式：key: value）
            if ':' in line and not line.startswith(' '):
                # 保存上一个键值对
                if current_key:
                    result[current_key] = '\n'.join(current_value).strip()

                # 解析新的键值对
                key, value = line.split(':', 1)
                current_key = key.strip()
                current_value = [value.strip()]
            else:
                # 续行（缩进表示值的延续）
                if current_key and line.strip():
                    current_value.append(line.strip())

        # 保存最后一个键值对
        if current_key:
            result[current_key] = '\n'.join(current_value).strip()

        return result


# 全局加载器实例（单例模式）
_skill_loader_instance: Optional[SkillLoader] = None


def get_skill_loader(skills_dir: str = None) -> SkillLoader:
    """获取全局 SkillLoader 实例"""
    global _skill_loader_instance

    if _skill_loader_instance is None:
        _skill_loader_instance = SkillLoader(skills_dir)

    return _skill_loader_instance

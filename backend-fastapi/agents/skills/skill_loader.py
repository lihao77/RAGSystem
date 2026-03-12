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
        self._environment = None  # 延迟初始化环境管理器

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

    def get_environment(self):
        """
        获取环境管理器（延迟初始化）

        Returns:
            SkillEnvironment 实例
        """
        if self._environment is None:
            from .skill_environment import get_skill_environment
            self._environment = get_skill_environment(self.skill_dir)
        return self._environment

    def execute_script(self, script_name: str, arguments: List[str] = None, timeout: int = 30) -> Dict:
        """
        在隔离环境中执行脚本

        Args:
            script_name: 脚本名称
            arguments: 命令行参数
            timeout: 超时时间（秒）

        Returns:
            执行结果字典 {stdout, stderr, return_code}
        """
        script_path = self.get_script_path(script_name)
        if not script_path:
            return {
                "stdout": "",
                "stderr": f"脚本不存在: {script_name}",
                "return_code": 1
            }

        env = self.get_environment()
        return env.execute_script(script_path, arguments, timeout)

    def has_scripts(self) -> bool:
        """检查是否有 scripts 目录"""
        scripts_dir = self.skill_dir / "scripts"
        return scripts_dir.exists() and scripts_dir.is_dir()

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

    def find_skill_metadata(self, skill_name: str) -> Optional[Dict]:
        """
        轻量查找 Skill 元数据。

        仅解析 SKILL.md 的 YAML front matter，不加载正文内容。
        """
        for skill_dir, skill_file in self._iter_skill_files():
            metadata = self._parse_skill_metadata_file(skill_file)
            if metadata and metadata.get('name') == skill_name:
                return {
                    'name': metadata['name'],
                    'description': metadata['description'],
                    'skill_dir': skill_dir,
                    'metadata': metadata,
                }
        return None

    def list_skill_names(self) -> List[str]:
        """轻量列出所有 Skill 名称。"""
        names = []
        for _, skill_file in self._iter_skill_files():
            metadata = self._parse_skill_metadata_file(skill_file)
            if metadata and metadata.get('name'):
                names.append(metadata['name'])
        return names

    def count_skill_resources(self, skill_dir: Path) -> int:
        """
        统计 Additional Resources 文件数量。

        排除 SKILL.md 和 scripts/ 目录下的脚本文件。
        """
        count = 0
        scripts_dir = skill_dir / "scripts"
        for path in skill_dir.rglob('*'):
            if not path.is_file():
                continue
            if path.name == "SKILL.md":
                continue
            if scripts_dir in path.parents:
                continue
            count += 1
        return count

    def _iter_skill_files(self):
        """遍历所有 Skill 目录及其 SKILL.md 文件。"""
        if not self.skills_dir.exists():
            logger.warning(f"Skills 目录不存在: {self.skills_dir}")
            return

        for skill_dir in self.skills_dir.iterdir():
            if skill_dir.is_dir() and not skill_dir.name.startswith('.'):
                skill_file = skill_dir / "SKILL.md"
                if skill_file.exists():
                    yield skill_dir, skill_file

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
            metadata, markdown_content = self._read_skill_file_parts(file_path)
            if metadata is None or markdown_content is None:
                return None

            return Skill(
                name=metadata['name'],
                description=metadata['description'],
                content=markdown_content,
                skill_dir=skill_dir,
                metadata=metadata
            )

        except Exception as e:
            logger.error(f"解析 SKILL.md 失败 {file_path}: {e}", exc_info=True)
            return None

    def _parse_skill_metadata_file(self, file_path: Path) -> Optional[Dict]:
        """只解析 SKILL.md 的 YAML front matter。"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                first_line = f.readline()
                if first_line.strip() != '---':
                    logger.error(f"SKILL.md 缺少 YAML 前置部分: {file_path}")
                    return None

                yaml_lines = []
                for line in f:
                    if line.strip() == '---':
                        break
                    yaml_lines.append(line.rstrip('\n'))
                else:
                    logger.error(f"SKILL.md 格式错误: {file_path}")
                    return None

            metadata = self._parse_simple_yaml('\n'.join(yaml_lines))
            name = metadata.get('name')
            description = metadata.get('description')
            if not name or not description:
                logger.error(f"SKILL.md 缺少必需字段 (name/description): {file_path}")
                return None
            return metadata
        except Exception as e:
            logger.error(f"解析 Skill 元数据失败 {file_path}: {e}", exc_info=True)
            return None

    def _read_skill_file_parts(self, file_path: Path) -> Tuple[Optional[Dict], Optional[str]]:
        """读取完整 Skill 文件，返回 front matter 与 Markdown 正文。"""
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        if not content.startswith('---'):
            logger.error(f"SKILL.md 缺少 YAML 前置部分: {file_path}")
            return None, None

        parts = content.split('---', 2)
        if len(parts) < 3:
            logger.error(f"SKILL.md 格式错误: {file_path}")
            return None, None

        metadata = self._parse_simple_yaml(parts[1].strip())
        name = metadata.get('name')
        description = metadata.get('description')
        if not name or not description:
            logger.error(f"SKILL.md 缺少必需字段 (name/description): {file_path}")
            return None, None

        return metadata, parts[2].strip()

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

# -*- coding: utf-8 -*-
"""
Skill 加载器 - 支持 Claude Skills 核心特性

功能：
1. 解析 SKILL.md 的 name 和 description
2. 支持 Additional resources（按需加载引用文件）
3. 支持 Utility scripts（零上下文执行）
4. 支持 builtin / workspace / user_global 多来源 Skill 目录
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from core.path_resolution import get_user_global_skills_root, get_workspace_skills_root

logger = logging.getLogger(__name__)


SKILL_SOURCE_PRIORITY = {
    "workspace": 3,
    "user_global": 2,
    "builtin": 1,
}

SKILL_SOURCE_LABELS = {
    "workspace": "工作区",
    "user_global": "全局",
    "builtin": "内置",
}


@dataclass(frozen=True)
class SkillSourceSpec:
    root: Path
    source_type: str
    source_label: str
    is_auto_inject_candidate: bool


class Skill:
    """Skill 数据类"""

    def __init__(
        self,
        name: str,
        description: str,
        content: str,
        skill_dir: Path,
        metadata: Dict = None,
        *,
        source_type: str = "builtin",
        source_label: str = "内置",
        is_auto_inject_candidate: bool = True,
        origin_root: Path | None = None,
    ):
        self.name = name
        self.description = description
        self.content = content
        self.skill_dir = skill_dir
        self.metadata = metadata or {}
        self.source_type = source_type
        self.source_label = source_label
        self.is_auto_inject_candidate = is_auto_inject_candidate
        self.origin_root = origin_root or skill_dir.parent
        self._environment = None

    def get_resource_file_content(self, file_name: str) -> Optional[str]:
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
        script_path = self.skill_dir / "scripts" / script_name
        if script_path.exists():
            return script_path.absolute()
        logger.warning(f"脚本不存在: {script_path}")
        return None

    def get_environment(self):
        if self._environment is None:
            from .skill_environment import get_skill_environment
            self._environment = get_skill_environment(self.skill_dir)
        return self._environment

    def execute_script(self, script_name: str, arguments: List[str] = None, timeout: int = 30) -> Dict:
        script_path = self.get_script_path(script_name)
        if not script_path:
            return {
                "stdout": "",
                "stderr": f"脚本不存在: {script_name}",
                "return_code": 1,
            }

        env = self.get_environment()
        return env.execute_script(script_path, arguments, timeout)

    def has_scripts(self) -> bool:
        scripts_dir = self.skill_dir / "scripts"
        return scripts_dir.exists() and scripts_dir.is_dir()

    def to_dict(self) -> Dict:
        return {
            'name': self.name,
            'description': self.description,
            'content_length': len(self.content),
            'metadata': self.metadata,
            'source_type': self.source_type,
            'source_label': self.source_label,
            'is_auto_inject_candidate': self.is_auto_inject_candidate,
            'origin_root': str(self.origin_root),
        }


class SkillLoader:
    """Skill 加载器"""

    _MAX_WORKSPACE_CACHE_SIZE = 16

    def __init__(self, skills_dir=None):
        builtin_root = Path(__file__).parent
        self._workspace_cache: OrderedDict[str, List[Skill]] = OrderedDict()
        self.skill_sources: List[SkillSourceSpec] = []

        if skills_dir is None:
            self.skill_sources = [
                SkillSourceSpec(
                    root=builtin_root,
                    source_type="builtin",
                    source_label=SKILL_SOURCE_LABELS["builtin"],
                    is_auto_inject_candidate=True,
                ),
                SkillSourceSpec(
                    root=get_user_global_skills_root(),
                    source_type="user_global",
                    source_label=SKILL_SOURCE_LABELS["user_global"],
                    is_auto_inject_candidate=False,
                ),
            ]
        elif isinstance(skills_dir, (str, Path)):
            self.skill_sources = [
                SkillSourceSpec(
                    root=Path(skills_dir),
                    source_type="builtin",
                    source_label=SKILL_SOURCE_LABELS["builtin"],
                    is_auto_inject_candidate=True,
                )
            ]
        else:
            self.skill_sources = [
                SkillSourceSpec(
                    root=Path(d),
                    source_type="builtin",
                    source_label=SKILL_SOURCE_LABELS["builtin"],
                    is_auto_inject_candidate=True,
                )
                for d in skills_dir
            ]

        self.skills_dirs = [spec.root for spec in self.skill_sources]
        self.skills_dir = self.skills_dirs[0]
        self._cached_skills: Optional[List[Skill]] = None
        logger.info("SkillLoader 初始化，Skills 目录: %s", self.skills_dirs)

    def invalidate_cache(self) -> None:
        self._cached_skills = None
        self._workspace_cache.clear()
        logger.info("Skills 缓存已清除")

    def add_skills_dir(
        self,
        skills_dir: str,
        *,
        source_type: str = "builtin",
        source_label: str | None = None,
        is_auto_inject_candidate: bool | None = None,
    ) -> None:
        p = Path(skills_dir)
        label = source_label or SKILL_SOURCE_LABELS.get(source_type, source_type)
        auto_inject = is_auto_inject_candidate if is_auto_inject_candidate is not None else source_type != "user_global"
        spec = SkillSourceSpec(
            root=p,
            source_type=source_type,
            source_label=label,
            is_auto_inject_candidate=auto_inject,
        )
        if spec.root not in {item.root for item in self.skill_sources}:
            self.skill_sources.append(spec)
            self.skills_dirs.append(spec.root)
            self.invalidate_cache()
            logger.info("追加 Skills 目录: %s (%s)", p, source_type)

    def load_all_skills(self, workspace_root: str | Path | None = None) -> List[Skill]:
        workspace_key = str(Path(workspace_root).resolve()) if workspace_root else None
        if workspace_key is None and self._cached_skills is not None:
            return list(self._cached_skills)
        if workspace_key is not None and workspace_key in self._workspace_cache:
            return list(self._workspace_cache[workspace_key])

        source_specs = list(self.skill_sources)
        if workspace_root:
            source_specs.insert(
                0,
                SkillSourceSpec(
                    root=get_workspace_skills_root(workspace_root),
                    source_type="workspace",
                    source_label=SKILL_SOURCE_LABELS["workspace"],
                    is_auto_inject_candidate=True,
                ),
            )

        skills = self._load_skills_from_sources(source_specs)
        if workspace_key is None:
            self._cached_skills = skills
        else:
            if len(self._workspace_cache) >= self._MAX_WORKSPACE_CACHE_SIZE:
                self._workspace_cache.popitem(last=False)
            self._workspace_cache[workspace_key] = skills
        return list(skills)

    def find_skill_metadata(self, skill_name: str, workspace_root: str | Path | None = None) -> Optional[Dict]:
        source_specs = list(self.skill_sources)
        if workspace_root:
            source_specs.insert(
                0,
                SkillSourceSpec(
                    root=get_workspace_skills_root(workspace_root),
                    source_type="workspace",
                    source_label=SKILL_SOURCE_LABELS["workspace"],
                    is_auto_inject_candidate=True,
                ),
            )

        best_match = None
        best_priority = -1
        for spec, skill_dir, skill_file in self._iter_skill_files(source_specs):
            metadata = self._parse_skill_metadata_file(skill_file)
            if not metadata or metadata.get('name') != skill_name:
                continue
            priority = SKILL_SOURCE_PRIORITY.get(spec.source_type, 0)
            if priority <= best_priority:
                continue
            best_priority = priority
            best_match = {
                'name': metadata['name'],
                'description': metadata['description'],
                'skill_dir': skill_dir,
                'metadata': metadata,
                'source_type': spec.source_type,
                'source_label': spec.source_label,
                'is_auto_inject_candidate': spec.is_auto_inject_candidate,
                'origin_root': spec.root,
            }
        return best_match

    def list_skill_names(self, workspace_root: str | Path | None = None) -> List[str]:
        return [skill.name for skill in self.load_all_skills(workspace_root=workspace_root)]

    def count_skill_resources(self, skill_dir: Path) -> int:
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

    def _load_skills_from_sources(self, source_specs: List[SkillSourceSpec]) -> List[Skill]:
        deduped: Dict[str, Skill] = {}
        for spec, skill_dir, skill_file in self._iter_skill_files(source_specs):
            skill = self._parse_skill_file(skill_file, skill_dir, spec)
            if not skill:
                continue
            existing = deduped.get(skill.name)
            if existing is not None:
                existing_priority = SKILL_SOURCE_PRIORITY.get(existing.source_type, 0)
                current_priority = SKILL_SOURCE_PRIORITY.get(skill.source_type, 0)
                if current_priority <= existing_priority:
                    logger.warning(
                        "Skill 名称冲突，保留 %s 来源并忽略 %s: %s",
                        existing.source_type,
                        skill.source_type,
                        skill.name,
                    )
                    continue
                logger.warning(
                    "Skill 名称冲突，使用更高优先级来源 %s 替换 %s: %s",
                    skill.source_type,
                    existing.source_type,
                    skill.name,
                )
            deduped[skill.name] = skill
            logger.info("✓ 加载 Skill: %s (%s)", skill.name, skill.source_type)

        skills = sorted(deduped.values(), key=lambda item: item.name)
        logger.info("共加载 %d 个 Skills", len(skills))
        return skills

    def _iter_skill_files(self, source_specs: Optional[List[SkillSourceSpec]] = None):
        for spec in source_specs or self.skill_sources:
            base_dir = spec.root
            if not base_dir.exists():
                logger.debug("Skills 目录不存在，跳过: %s", base_dir)
                continue
            for skill_dir in base_dir.iterdir():
                if skill_dir.is_dir() and not skill_dir.name.startswith('.'):
                    skill_file = skill_dir / "SKILL.md"
                    if skill_file.exists():
                        yield spec, skill_dir, skill_file

    def _parse_skill_file(self, file_path: Path, skill_dir: Path, source_spec: SkillSourceSpec) -> Optional[Skill]:
        try:
            metadata, markdown_content = self._read_skill_file_parts(file_path)
            if metadata is None or markdown_content is None:
                return None

            return Skill(
                name=metadata['name'],
                description=metadata['description'],
                content=markdown_content,
                skill_dir=skill_dir,
                metadata=metadata,
                source_type=source_spec.source_type,
                source_label=source_spec.source_label,
                is_auto_inject_candidate=source_spec.is_auto_inject_candidate,
                origin_root=source_spec.root,
            )
        except Exception as e:
            logger.error(f"解析 SKILL.md 失败 {file_path}: {e}", exc_info=True)
            return None

    def _parse_skill_metadata_file(self, file_path: Path) -> Optional[Dict]:
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
        result = {}
        lines = yaml_str.split('\n')
        current_key = None
        current_value = []

        for line in lines:
            if ':' in line and not line.startswith(' '):
                if current_key:
                    result[current_key] = '\n'.join(current_value).strip()
                key, value = line.split(':', 1)
                current_key = key.strip()
                current_value = [value.strip()]
            else:
                if current_key and line.strip():
                    current_value.append(line.strip())

        if current_key:
            result[current_key] = '\n'.join(current_value).strip()
        return result


_skill_loader_instance: Optional[SkillLoader] = None


def get_skill_loader(skills_dir: str = None) -> SkillLoader:
    global _skill_loader_instance
    if _skill_loader_instance is None:
        _skill_loader_instance = SkillLoader(skills_dir)
    return _skill_loader_instance


def invalidate_skill_cache() -> None:
    if _skill_loader_instance is not None:
        _skill_loader_instance.invalidate_cache()

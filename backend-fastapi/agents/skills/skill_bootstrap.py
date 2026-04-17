# -*- coding: utf-8 -*-
"""
内置 Skill 初始化：首次运行时复制到全局 skill 目录。

调用时机：系统启动（lifespan），在 ensure_directories 之后。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

BUILTIN_SKILLS_ROOT = Path(__file__).parent  # agents/skills/

# 不应被复制的文件/目录
_SKIP_NAMES = {
    "__pycache__",
    ".gitignore",
    ".venv",
    ".cache",
    "skill_loader.py",
    "skill_environment.py",
    "skill_bootstrap.py",
    "__init__.py",
}


def _is_builtin_skill_dir(path: Path) -> bool:
    """判断是否是一个内置 skill 目录（含 SKILL.md）"""
    return path.is_dir() and (path / "SKILL.md").exists()


def bootstrap_builtin_skills(target_root: Path | None = None) -> list[str]:
    """将内置 skill 复制到全局 skill 目录，已存在的跳过。

    Returns:
        新复制的 skill 名称列表
    """
    if target_root is None:
        from core.path_resolution import get_user_global_skills_root
        target_root = get_user_global_skills_root()

    target_root.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []

    for src_dir in sorted(BUILTIN_SKILLS_ROOT.iterdir()):
        if src_dir.name in _SKIP_NAMES or not _is_builtin_skill_dir(src_dir):
            continue

        dst_dir = target_root / src_dir.name
        if dst_dir.exists():
            logger.debug("内置 Skill 已存在，跳过: %s", src_dir.name)
            continue

        try:
            shutil.copytree(
                src_dir,
                dst_dir,
                ignore=shutil.ignore_patterns("__pycache__", ".venv", ".cache"),
            )
            copied.append(src_dir.name)
            logger.info("✓ 复制内置 Skill: %s → %s", src_dir.name, dst_dir)
        except Exception as e:
            logger.error("复制内置 Skill 失败 %s: %s", src_dir.name, e)

    if copied:
        logger.info("共复制 %d 个内置 Skill 到 %s", len(copied), target_root)
    else:
        logger.debug("无需复制内置 Skill（全局目录已包含所有内置 Skill）")

    return copied

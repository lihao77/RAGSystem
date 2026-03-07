# -*- coding: utf-8 -*-
"""带迁移与备份语义的 YAML 文件 helper。"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from shutil import copy2
from typing import Any, Callable, Optional, Tuple

from .file_lock import FileLock
from .yaml_store import load_yaml_file, save_yaml_file


MigrateCallback = Optional[Callable[[Any], Tuple[Any, bool]]]
DefaultFactory = Optional[Callable[[], Any]]


def build_backup_path(path: str | Path) -> Path:
    """生成与源文件同目录的 `.backup` 文件路径。"""
    file_path = Path(path)
    return file_path.with_name(f'{file_path.stem}.backup{file_path.suffix}')


def backup_yaml_file(path: str | Path, *, backup_path: Optional[str | Path] = None) -> Optional[Path]:
    """为现有 YAML 文件创建一份备份。"""
    file_path = Path(path)
    if not file_path.exists():
        return None

    target = Path(backup_path) if backup_path is not None else build_backup_path(file_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(file_path):
        copy2(file_path, target)
    return target


def load_versioned_yaml_file(
    path: str | Path,
    *,
    default_factory: DefaultFactory = None,
    migrate: MigrateCallback = None,
    persist_on_change: bool = False,
    backup_on_change: bool = False,
    backup_path: Optional[str | Path] = None,
    sort_keys: bool = False,
    indent: Optional[int] = None,
    default_flow_style: bool = False,
) -> tuple[Any, bool]:
    """读取 YAML，并在需要时执行迁移、备份和落盘。"""
    file_path = Path(path)
    with FileLock(file_path):
        data = load_yaml_file(file_path, default_factory=default_factory)
        changed = False

        if migrate is not None:
            data, changed = migrate(deepcopy(data))

        if changed and persist_on_change:
            if backup_on_change and file_path.exists():
                target = Path(backup_path) if backup_path is not None else build_backup_path(file_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                copy2(file_path, target)
            save_yaml_file(
                file_path,
                data,
                sort_keys=sort_keys,
                indent=indent,
                default_flow_style=default_flow_style,
            )

        return data, changed


def save_versioned_yaml_file(
    path: str | Path,
    data: Any,
    *,
    backup: bool = False,
    backup_path: Optional[str | Path] = None,
    sort_keys: bool = False,
    indent: Optional[int] = None,
    default_flow_style: bool = False,
) -> Optional[Path]:
    """写入 YAML，并可在覆盖前创建 `.backup` 文件。"""
    file_path = Path(path)
    with FileLock(file_path):
        backup_file = None
        if backup and file_path.exists():
            target = Path(backup_path) if backup_path is not None else build_backup_path(file_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            copy2(file_path, target)
            backup_file = target

        save_yaml_file(
            file_path,
            data,
            sort_keys=sort_keys,
            indent=indent,
            default_flow_style=default_flow_style,
        )
        return backup_file

# -*- coding: utf-8 -*-
"""共享 YAML 文件读写工具。"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

import yaml

from .file_lock import FileLock


DefaultFactory = Optional[Callable[[], Any]]


def load_yaml_file(path: str | Path, *, default_factory: DefaultFactory = None) -> Any:
    """读取 YAML 文件；文件不存在或内容为空时返回默认值。"""
    file_path = Path(path)
    if not file_path.exists():
        return default_factory() if default_factory is not None else None

    with open(file_path, 'r', encoding='utf-8') as handle:
        data = yaml.safe_load(handle)

    if data is None and default_factory is not None:
        return default_factory()
    return data


def save_yaml_file(
    path: str | Path,
    data: Any,
    *,
    sort_keys: bool = False,
    indent: Optional[int] = None,
    default_flow_style: bool = False,
) -> None:
    """以原子替换方式写入 YAML 文件。"""
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)

    with FileLock(file_path):
        temp_path: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(
                'w',
                encoding='utf-8',
                dir=file_path.parent,
                prefix=f'.{file_path.name}.',
                suffix='.tmp',
                delete=False,
            ) as handle:
                yaml.safe_dump(
                    data,
                    handle,
                    allow_unicode=True,
                    default_flow_style=default_flow_style,
                    sort_keys=sort_keys,
                    indent=indent,
                )
                temp_path = Path(handle.name)

            os.replace(temp_path, file_path)
        except Exception:
            if temp_path is not None and temp_path.exists():
                temp_path.unlink(missing_ok=True)
            raise

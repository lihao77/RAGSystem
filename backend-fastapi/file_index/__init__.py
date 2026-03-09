# -*- coding: utf-8 -*-
"""
文件索引模块

提供文件元数据管理功能，支持：
- YAML 文件存储（旧版，向后兼容）
- SQLite 数据库存储（新版，推荐）
"""

from pathlib import Path
from .store import FileIndex as FileIndexYAML
from .sqlite_store import FileIndexSQLite


def get_file_index(use_sqlite: bool = True, **kwargs):
    """
    获取文件索引实例（工厂函数）

    Args:
        use_sqlite: 是否使用 SQLite 存储（默认 True）
        **kwargs: 传递给存储实现的参数

    Returns:
        FileIndex 实例（YAML 或 SQLite）
    """
    if use_sqlite:
        # 检查 SQLite 数据库是否存在
        db_path = kwargs.get('db_path') or (Path(__file__).parent / "files.db")
        if Path(db_path).exists():
            return FileIndexSQLite(**kwargs)
        else:
            # 数据库不存在，检查是否有 YAML 数据需要迁移
            yaml_path = Path(__file__).parent / "files.yaml"
            if yaml_path.exists():
                import logging
                logger = logging.getLogger(__name__)
                logger.warning(
                    "检测到 YAML 文件但 SQLite 数据库不存在。"
                    "请运行迁移脚本: python -m utils.migrate_file_index"
                )
                # 临时使用 YAML 存储
                return FileIndexYAML(**kwargs)
            else:
                # 两者都不存在，创建新的 SQLite 数据库
                return FileIndexSQLite(**kwargs)
    else:
        return FileIndexYAML(**kwargs)


# 默认导出 SQLite 版本
FileIndex = FileIndexSQLite

__all__ = ['FileIndex', 'FileIndexYAML', 'FileIndexSQLite', 'get_file_index']

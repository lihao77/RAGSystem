# -*- coding: utf-8 -*-
"""
文件索引模块

基于 SQLite 的文件元数据管理。
"""

from .sqlite_store import FileIndexSQLite

FileIndex = FileIndexSQLite

__all__ = ['FileIndex', 'FileIndexSQLite']

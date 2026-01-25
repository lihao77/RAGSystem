#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
合并数据库文件：将 file_index/files.db 合并到 data/vector_store.db

优点：
1. 单一数据源，统一管理
2. 可以跨表查询（例如：查询已索引到向量库的文件）
3. 统一备份和恢复
4. 减少文件管理复杂度

执行步骤：
1. 在 vector_store.db 中创建 uploaded_files 表
2. 从 files.db 复制数据
3. 备份并删除 files.db
4. 更新 FileIndexSQLite 使用统一的数据库路径
"""

import sys
import sqlite3
import shutil
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

import logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


def merge_databases():
    """合并文件索引数据库到向量存储数据库"""

    base_dir = Path(__file__).parent.parent
    unified_db = base_dir / "data" / "ragsystem.db"
    vector_db_old = base_dir / "data" / "vector_store.db"
    file_index_db = base_dir / "file_index" / "files.db"

    logger.info("=" * 70)
    logger.info("数据库合并工具：统一到 ragsystem.db")
    logger.info("=" * 70)

    # 检查并重命名旧的向量数据库
    if vector_db_old.exists() and not unified_db.exists():
        logger.info(f"检测到旧数据库: {vector_db_old}")
        logger.info(f"重命名为: {unified_db}")
        shutil.move(str(vector_db_old), str(unified_db))
        logger.info("✅ 数据库重命名完成")

    # 检查源数据库
    if not file_index_db.exists():
        logger.warning(f"文件索引数据库不存在: {file_index_db}")

        # 如果统一数据库也不存在，创建它
        if not unified_db.exists():
            logger.info("创建新的统一数据库...")
            conn = sqlite3.connect(unified_db)
            conn.close()
            logger.info(f"✅ 已创建: {unified_db}")

        return True

    if not unified_db.exists():
        logger.error(f"统一数据库不存在: {unified_db}")
        logger.info("请先运行后端服务以初始化数据库")
        return False

    # 备份文件索引数据库
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = file_index_db.with_suffix(f".backup_{timestamp}.db")
    shutil.copy2(file_index_db, backup_path)
    logger.info(f"✅ 已备份 files.db: {backup_path}")

    try:
        # 连接两个数据库
        unified_conn = sqlite3.connect(unified_db)
        unified_conn.row_factory = sqlite3.Row

        file_conn = sqlite3.connect(file_index_db)
        file_conn.row_factory = sqlite3.Row

        # 1. 在统一数据库中创建 uploaded_files 表
        logger.info("步骤 1: 在统一数据库中创建 uploaded_files 表...")
        unified_conn.execute("""
            CREATE TABLE IF NOT EXISTS uploaded_files (
                id TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mime TEXT,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                uploaded_by TEXT,
                indexed_in_vector BOOLEAN DEFAULT FALSE,
                tags TEXT,
                notes TEXT
            )
        """)

        unified_conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_uploaded_at
            ON uploaded_files(uploaded_at)
        """)

        unified_conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_mime
            ON uploaded_files(mime)
        """)

        unified_conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_indexed
            ON uploaded_files(indexed_in_vector)
        """)

        unified_conn.commit()
        logger.info("✅ 表结构创建完成")

        # 2. 复制数据
        logger.info("步骤 2: 复制文件索引数据...")
        cursor = file_conn.execute("SELECT * FROM uploaded_files")
        rows = cursor.fetchall()

        logger.info(f"找到 {len(rows)} 条记录待迁移")

        success_count = 0
        for row in rows:
            try:
                # 检查是否已存在（避免重复）
                existing = unified_conn.execute(
                    "SELECT id FROM uploaded_files WHERE id = ?",
                    (row['id'],)
                ).fetchone()

                if existing:
                    logger.info(f"⚠️  跳过已存在: {row['id']}")
                    success_count += 1
                    continue

                # 插入数据
                unified_conn.execute(
                    """
                    INSERT INTO uploaded_files
                    (id, original_name, stored_name, stored_path, size, mime,
                     uploaded_at, uploaded_by, indexed_in_vector, tags, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row['id'],
                        row['original_name'],
                        row['stored_name'],
                        row['stored_path'],
                        row['size'],
                        row['mime'],
                        row['uploaded_at'],
                        row['uploaded_by'],
                        row['indexed_in_vector'],
                        row['tags'],
                        row['notes']
                    )
                )
                success_count += 1
                logger.info(f"✅ 迁移: {row['id']} - {row['original_name']}")

            except Exception as e:
                logger.error(f"❌ 迁移失败: {row['id']} - {e}")

        unified_conn.commit()

        # 3. 验证数据
        logger.info("步骤 3: 验证数据...")
        source_count = len(rows)
        target_count = unified_conn.execute(
            "SELECT COUNT(*) as count FROM uploaded_files"
        ).fetchone()['count']

        logger.info(f"源数据库: {source_count} 条")
        logger.info(f"目标数据库: {target_count} 条")

        if target_count >= source_count:
            logger.info("✅ 数据验证通过")
        else:
            logger.warning("⚠️  数据验证失败，目标记录数少于源记录数")
            return False

        # 关闭连接
        file_conn.close()
        unified_conn.close()

        logger.info("=" * 70)
        logger.info("✅ 数据库合并完成")
        logger.info("=" * 70)
        logger.info(f"统一数据库: {unified_db}")
        logger.info(f"备份文件: {backup_path}")
        logger.info("")
        logger.info("下一步:")
        logger.info("  1. 删除旧数据库: rm " + str(file_index_db))
        logger.info("  2. 更新配置使用统一数据库")
        logger.info("  3. 重启后端服务")

        return True

    except Exception as e:
        logger.error(f"❌ 合并失败: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description="合并 SQLite 数据库文件")
    parser.add_argument(
        '--execute',
        action='store_true',
        help='实际执行合并（默认为预览模式）'
    )

    args = parser.parse_args()

    if not args.execute:
        print("=" * 70)
        print("预览模式（不会实际修改数据）")
        print("=" * 70)
        print("")
        print("此工具将：")
        print("  1. 在 vector_store.db 中创建 uploaded_files 表")
        print("  2. 从 files.db 复制所有数据")
        print("  3. 备份 files.db")
        print("")
        print("要执行合并，请运行：")
        print("  python utils/merge_databases.py --execute")
        print("")
        sys.exit(0)

    success = merge_databases()
    sys.exit(0 if success else 1)

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
文件索引数据迁移脚本

功能：
1. 从 YAML 文件读取现有文件索引数据
2. 迁移到 SQLite 数据库
3. 备份原 YAML 文件
4. 支持回滚（从备份恢复）
"""

import sys
import yaml
import shutil
import logging
from pathlib import Path
from datetime import datetime

# 添加父目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from file_index.sqlite_store import FileIndexSQLite

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def migrate_yaml_to_sqlite():
    """
    主迁移函数

    流程：
    1. 检查 YAML 文件是否存在
    2. 备份 YAML 文件
    3. 读取 YAML 数据
    4. 写入 SQLite
    5. 验证数据一致性
    """
    base_dir = Path(__file__).parent.parent / "file_index"
    yaml_path = base_dir / "files.yaml"
    db_path = base_dir / "files.db"

    logger.info("=" * 60)
    logger.info("开始文件索引数据迁移：YAML → SQLite")
    logger.info("=" * 60)

    # 1. 检查 YAML 文件
    if not yaml_path.exists():
        logger.warning(f"YAML 文件不存在: {yaml_path}")
        logger.info("创建空的 SQLite 数据库...")
        sqlite_store = FileIndexSQLite(db_path)
        logger.info("✅ SQLite 数据库已创建")
        return True

    # 2. 备份 YAML 文件
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = yaml_path.with_suffix(f".backup_{timestamp}.yaml")

    try:
        shutil.copy2(yaml_path, backup_path)
        logger.info(f"✅ YAML 文件已备份: {backup_path}")
    except Exception as e:
        logger.error(f"❌ 备份失败: {e}")
        return False

    # 3. 读取 YAML 数据
    try:
        with open(yaml_path, 'r', encoding='utf-8') as f:
            yaml_data = yaml.safe_load(f) or {}
        logger.info(f"✅ 已读取 YAML 数据，共 {len(yaml_data)} 条记录")
    except Exception as e:
        logger.error(f"❌ 读取 YAML 文件失败: {e}")
        return False

    # 4. 初始化 SQLite 存储
    try:
        sqlite_store = FileIndexSQLite(db_path)
        logger.info(f"✅ SQLite 数据库已初始化: {db_path}")
    except Exception as e:
        logger.error(f"❌ 初始化 SQLite 失败: {e}")
        return False

    # 5. 迁移数据
    success_count = 0
    failed_count = 0

    for file_id, file_data in yaml_data.items():
        try:
            # 检查是否已存在（避免重复迁移）
            existing = sqlite_store.get(file_id)
            if existing:
                logger.info(f"⚠️  跳过已存在的记录: {file_id}")
                success_count += 1
                continue

            # 插入数据（使用 YAML 中的原始 ID 和时间戳）
            with sqlite_store._get_connection() as conn:
                conn.execute(
                    """
                    INSERT INTO uploaded_files
                    (id, original_name, stored_name, stored_path, size, mime,
                     uploaded_at, uploaded_by, indexed_in_vector, tags)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        file_id,
                        file_data.get("original_name", ""),
                        file_data.get("stored_name", ""),
                        file_data.get("stored_path", ""),
                        file_data.get("size", 0),
                        file_data.get("mime", ""),
                        file_data.get("uploaded_at", datetime.now().isoformat()),
                        None,  # uploaded_by
                        False,  # indexed_in_vector
                        None  # tags
                    )
                )
                conn.commit()

            success_count += 1
            logger.info(f"✅ 迁移成功: {file_id} - {file_data.get('original_name')}")

        except Exception as e:
            failed_count += 1
            logger.error(f"❌ 迁移失败: {file_id} - {e}")

    # 6. 验证数据一致性
    sqlite_count = sqlite_store.count()
    logger.info("=" * 60)
    logger.info("迁移完成统计:")
    logger.info(f"  YAML 原始记录: {len(yaml_data)}")
    logger.info(f"  SQLite 记录: {sqlite_count}")
    logger.info(f"  成功迁移: {success_count}")
    logger.info(f"  失败: {failed_count}")
    logger.info("=" * 60)

    if sqlite_count == len(yaml_data):
        logger.info("✅ 数据验证通过，记录数量一致")
        logger.info(f"📁 YAML 备份: {backup_path}")
        logger.info(f"💾 SQLite 数据库: {db_path}")
        return True
    else:
        logger.warning("⚠️  数据验证失败，记录数量不一致")
        return False


def rollback_migration():
    """
    回滚迁移

    从最新的备份文件恢复 YAML，删除 SQLite 数据库
    """
    base_dir = Path(__file__).parent.parent / "file_index"
    yaml_path = base_dir / "files.yaml"
    db_path = base_dir / "files.db"

    logger.info("=" * 60)
    logger.info("开始回滚迁移...")
    logger.info("=" * 60)

    # 查找最新的备份文件
    backup_files = sorted(base_dir.glob("files.backup_*.yaml"), reverse=True)

    if not backup_files:
        logger.error("❌ 未找到备份文件，无法回滚")
        return False

    latest_backup = backup_files[0]
    logger.info(f"找到最新备份: {latest_backup}")

    try:
        # 恢复 YAML 文件
        shutil.copy2(latest_backup, yaml_path)
        logger.info(f"✅ YAML 文件已恢复: {yaml_path}")

        # 删除 SQLite 数据库
        if db_path.exists():
            db_path.unlink()
            logger.info(f"✅ SQLite 数据库已删除: {db_path}")

        logger.info("=" * 60)
        logger.info("✅ 回滚成功")
        logger.info("=" * 60)
        return True

    except Exception as e:
        logger.error(f"❌ 回滚失败: {e}")
        return False


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description="文件索引数据迁移工具")
    parser.add_argument(
        '--rollback',
        action='store_true',
        help='回滚迁移（从备份恢复 YAML）'
    )

    args = parser.parse_args()

    if args.rollback:
        success = rollback_migration()
    else:
        success = migrate_yaml_to_sqlite()

    sys.exit(0 if success else 1)

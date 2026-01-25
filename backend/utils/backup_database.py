#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
数据库备份脚本（Python 版本，跨平台）

功能：
- 备份 ragsystem.db 数据库
- 使用 SQLite VACUUM INTO 命令（热备份，无需停机）
- 可选压缩备份文件
- 自动清理超过指定天数的旧备份
"""

import sys
import sqlite3
import gzip
import shutil
from pathlib import Path
from datetime import datetime, timedelta
import argparse
import logging

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


def backup_database(
    db_path: Path,
    backup_dir: Path,
    compress: bool = True,
    cleanup_days: int = 30
):
    """
    备份数据库

    Args:
        db_path: 数据库文件路径
        backup_dir: 备份目录
        compress: 是否压缩备份
        cleanup_days: 清理多少天前的备份（0 表示不清理）
    """
    logger.info("=" * 70)
    logger.info("开始备份数据库")
    logger.info("=" * 70)

    # 检查数据库文件
    if not db_path.exists():
        logger.error(f"❌ 数据库文件不存在: {db_path}")
        return False

    # 创建备份目录
    backup_dir.mkdir(parents=True, exist_ok=True)

    # 生成备份文件名
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = backup_dir / f"ragsystem_{timestamp}.db"

    logger.info(f"数据库: {db_path}")
    logger.info(f"备份到: {backup_file}")
    logger.info("")

    try:
        # 使用 SQLite VACUUM INTO 进行热备份
        conn = sqlite3.connect(str(db_path))
        conn.execute(f"VACUUM INTO '{backup_file}'")
        conn.close()

        file_size_mb = backup_file.stat().st_size / (1024 * 1024)
        logger.info(f"✅ 备份完成: {backup_file}")
        logger.info(f"文件大小: {file_size_mb:.2f} MB")

        # 压缩备份
        if compress:
            logger.info("")
            logger.info("压缩备份文件...")
            compressed_file = Path(str(backup_file) + ".gz")

            with open(backup_file, 'rb') as f_in:
                with gzip.open(compressed_file, 'wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)

            compressed_size_mb = compressed_file.stat().st_size / (1024 * 1024)
            logger.info(f"✅ 压缩完成: {compressed_file}")
            logger.info(f"压缩后大小: {compressed_size_mb:.2f} MB")
            logger.info(f"压缩率: {(1 - compressed_size_mb / file_size_mb) * 100:.1f}%")

            # 删除未压缩的备份
            backup_file.unlink()

        # 清理旧备份
        if cleanup_days > 0:
            logger.info("")
            logger.info(f"清理旧备份（超过 {cleanup_days} 天）...")
            cleanup_old_backups(backup_dir, cleanup_days, compress)

        # 列出所有备份
        logger.info("")
        logger.info("现有备份:")
        pattern = "ragsystem_*.db.gz" if compress else "ragsystem_*.db"
        backups = sorted(backup_dir.glob(pattern), reverse=True)

        for backup in backups:
            size_mb = backup.stat().st_size / (1024 * 1024)
            logger.info(f"  {backup.name} ({size_mb:.2f} MB)")

        logger.info("")
        logger.info("=" * 70)
        logger.info("✅ 备份完成")

        return True

    except Exception as e:
        logger.error(f"❌ 备份失败: {e}")
        import traceback
        traceback.print_exc()
        return False


def cleanup_old_backups(backup_dir: Path, days: int, compressed: bool):
    """清理超过指定天数的旧备份"""
    pattern = "ragsystem_*.db.gz" if compressed else "ragsystem_*.db"
    cutoff_date = datetime.now() - timedelta(days=days)

    deleted_count = 0
    for backup_file in backup_dir.glob(pattern):
        # 检查文件修改时间
        mtime = datetime.fromtimestamp(backup_file.stat().st_mtime)
        if mtime < cutoff_date:
            backup_file.unlink()
            deleted_count += 1
            logger.info(f"  删除: {backup_file.name}")

    if deleted_count > 0:
        logger.info(f"✅ 已删除 {deleted_count} 个旧备份")
    else:
        logger.info("没有需要清理的旧备份")


def restore_database(backup_file: Path, db_path: Path):
    """
    从备份恢复数据库

    Args:
        backup_file: 备份文件路径（.db 或 .db.gz）
        db_path: 目标数据库路径
    """
    logger.info("=" * 70)
    logger.info("恢复数据库")
    logger.info("=" * 70)

    if not backup_file.exists():
        logger.error(f"❌ 备份文件不存在: {backup_file}")
        return False

    logger.info(f"备份文件: {backup_file}")
    logger.info(f"恢复到: {db_path}")
    logger.info("")

    try:
        # 备份当前数据库
        if db_path.exists():
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            old_db_backup = db_path.with_suffix(f".before_restore_{timestamp}.db")
            shutil.copy2(db_path, old_db_backup)
            logger.info(f"✅ 当前数据库已备份到: {old_db_backup}")

        # 恢复数据库
        if backup_file.suffix == ".gz":
            # 解压缩
            logger.info("解压缩备份文件...")
            with gzip.open(backup_file, 'rb') as f_in:
                with open(db_path, 'wb') as f_out:
                    shutil.copyfileobj(f_in, f_out)
        else:
            # 直接复制
            shutil.copy2(backup_file, db_path)

        logger.info(f"✅ 数据库已恢复: {db_path}")
        logger.info("")
        logger.info("=" * 70)
        logger.info("✅ 恢复完成")

        return True

    except Exception as e:
        logger.error(f"❌ 恢复失败: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="数据库备份/恢复工具")
    parser.add_argument(
        '--restore',
        type=str,
        metavar='BACKUP_FILE',
        help='从指定备份文件恢复数据库'
    )
    parser.add_argument(
        '--no-compress',
        action='store_true',
        help='不压缩备份文件'
    )
    parser.add_argument(
        '--cleanup-days',
        type=int,
        default=30,
        help='清理多少天前的备份（默认 30 天，0 表示不清理）'
    )
    parser.add_argument(
        '--db-path',
        type=str,
        default=None,
        help='数据库文件路径（默认: backend/data/ragsystem.db）'
    )
    parser.add_argument(
        '--backup-dir',
        type=str,
        default="backups",
        help='备份目录（默认: backups）'
    )

    args = parser.parse_args()

    # 确定路径
    if args.db_path:
        db_path = Path(args.db_path)
    else:
        base_dir = Path(__file__).parent.parent
        db_path = base_dir / "data" / "ragsystem.db"

    backup_dir = Path(args.backup_dir)

    # 恢复模式
    if args.restore:
        backup_file = Path(args.restore)
        success = restore_database(backup_file, db_path)
    # 备份模式
    else:
        success = backup_database(
            db_path=db_path,
            backup_dir=backup_dir,
            compress=not args.no_compress,
            cleanup_days=args.cleanup_days
        )

    sys.exit(0 if success else 1)

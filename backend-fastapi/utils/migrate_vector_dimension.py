#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
向量维度迁移工具

当更换 Embedding 模型（导致向量维度变化）时，使用此工具重新编码所有文档。

用法:
    python -m utils.migrate_vector_dimension [--collection <name>] [--batch-size <size>]

示例:
    python -m utils.migrate_vector_dimension                    # 迁移所有集合
    python -m utils.migrate_vector_dimension --collection default  # 仅迁移指定集合
"""

import sys
import json
import logging
import argparse
import sqlite3
from pathlib import Path
from typing import List, Dict, Any
from tqdm import tqdm

from vector_store import get_vector_client, get_embedder
from vector_store.base import Document
from config import get_config

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class VectorDimensionMigrator:
    """向量维度迁移器"""

    def __init__(self):
        self.config = get_config()
        self.embedder = get_embedder()
        self.vector_client = get_vector_client()

        # 初始化
        self.embedder.initialize(self.config)
        logger.info(f"✓ Embedder 已初始化 (维度: {self.embedder.embedding_dim})")

    def get_old_documents(self, db_path: str, collection: str = None) -> List[Dict[str, Any]]:
        """
        从旧数据库读取文档（不含向量）

        Args:
            db_path: 数据库路径
            collection: 集合名称（None 表示所有集合）

        Returns:
            文档列表
        """
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        if collection:
            query = "SELECT id, collection, content, metadata FROM documents WHERE collection = ?"
            cursor = conn.execute(query, (collection,))
        else:
            query = "SELECT id, collection, content, metadata FROM documents"
            cursor = conn.execute(query)

        documents = []
        for row in cursor.fetchall():
            documents.append({
                "id": row["id"],
                "collection": row["collection"],
                "content": row["content"],
                "metadata": json.loads(row["metadata"]) if row["metadata"] else {}
            })

        conn.close()
        logger.info(f"✓ 从旧数据库读取了 {len(documents)} 条文档")
        return documents

    def migrate(self, collection: str = None, batch_size: int = 50):
        """
        执行迁移

        Args:
            collection: 要迁移的集合名称（None 表示所有集合）
            batch_size: 批处理大小
        """
        # 1. 获取数据库路径
        db_path = Path(self.config.vector_store.sqlite_vec.database_path)
        if not db_path.is_absolute():
            db_path = Path(__file__).parent.parent / db_path

        if not db_path.exists():
            logger.error(f"❌ 数据库文件不存在: {db_path}")
            return

        # 2. 读取旧文档
        logger.info("步骤 1/4: 读取现有文档...")
        old_documents = self.get_old_documents(str(db_path), collection)

        if not old_documents:
            logger.info("✓ 没有需要迁移的文档")
            return

        # 3. 备份数据库
        logger.info("步骤 2/4: 备份数据库...")
        backup_path = db_path.with_suffix('.db.backup')
        import shutil
        shutil.copy2(db_path, backup_path)
        logger.info(f"✓ 已备份到: {backup_path}")

        # 4. 初始化新的向量存储（会自动检测维度不匹配并重建）
        logger.info("步骤 3/4: 初始化新向量存储...")
        self.vector_client.initialize(self.config)

        # 5. 重新编码并插入文档
        logger.info(f"步骤 4/4: 重新编码 {len(old_documents)} 条文档...")

        # 按集合分组
        collections = {}
        for doc in old_documents:
            coll = doc["collection"]
            if coll not in collections:
                collections[coll] = []
            collections[coll].append(doc)

        # 逐集合迁移
        total_migrated = 0
        for coll_name, docs in collections.items():
            logger.info(f"\n迁移集合 '{coll_name}' ({len(docs)} 条文档)...")

            # 批处理编码和插入
            for i in tqdm(range(0, len(docs), batch_size), desc=f"集合 {coll_name}"):
                batch = docs[i:i + batch_size]

                # 提取文本内容
                texts = [doc["content"] for doc in batch]

                # 批量编码
                try:
                    embeddings = self.embedder.embed(texts)
                except Exception as e:
                    logger.error(f"❌ 编码失败: {e}")
                    continue

                # 构建 Document 对象
                documents = []
                for doc, embedding in zip(batch, embeddings):
                    documents.append(Document(
                        id=doc["id"],
                        content=doc["content"],
                        metadata=doc["metadata"],
                        embedding=embedding
                    ))

                # 插入到新数据库
                try:
                    self.vector_client.add_documents(documents, collection=coll_name)
                    total_migrated += len(documents)
                except Exception as e:
                    logger.error(f"❌ 插入失败: {e}")
                    continue

        logger.info(f"\n✅ 迁移完成！")
        logger.info(f"   总共迁移: {total_migrated}/{len(old_documents)} 条文档")
        logger.info(f"   新向量维度: {self.embedder.embedding_dim}")
        logger.info(f"   备份位置: {backup_path}")


def main():
    parser = argparse.ArgumentParser(description="向量维度迁移工具")
    parser.add_argument(
        "--collection",
        type=str,
        default=None,
        help="要迁移的集合名称（默认迁移所有集合）"
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=50,
        help="批处理大小（默认 50）"
    )

    args = parser.parse_args()

    print("=" * 60)
    print("向量维度迁移工具")
    print("=" * 60)
    print()

    # 创建迁移器
    migrator = VectorDimensionMigrator()

    # 执行迁移
    try:
        migrator.migrate(
            collection=args.collection,
            batch_size=args.batch_size
        )
    except KeyboardInterrupt:
        logger.warning("\n⚠️  迁移已中断")
        sys.exit(1)
    except Exception as e:
        logger.error(f"\n❌ 迁移失败: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()

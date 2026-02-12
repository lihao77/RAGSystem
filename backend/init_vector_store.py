#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
向量数据库启动初始化

支持延迟初始化：
- 系统启动时如果已配置，自动初始化
- 如果未配置，推迟到配置完成后初始化
"""

import logging
from vector_store import get_vector_client, get_embedder
from config import get_config

logger = logging.getLogger(__name__)

# 全局初始化标记
_vector_store_initialized = False


def is_vector_db_configured():
    """
    检查向量数据库是否已配置

    Returns:
        bool: 是否已配置嵌入模型
    """
    try:
        config = get_config()

        # 检查是否配置了 provider 和 model_name
        # 由于我们依赖 Model Adapter，这里只需检查 provider 是否存在
        # 具体的连接有效性在初始化时检查
        return bool(config.embedding.provider and config.embedding.model_name)

    except Exception as e:
        logger.error(f"检查向量数据库配置失败: {e}")
        return False


def is_vector_store_initialized():
    """
    检查向量数据库是否已初始化

    Returns:
        bool: 是否已初始化
    """
    return _vector_store_initialized


def init_vector_store(force=False):
    """
    初始化向量数据库

    支持延迟初始化和避免重复初始化

    Args:
        force: 是否强制重新初始化（用于配置更新后）

    Returns:
        bool: 初始化是否成功
    """
    global _vector_store_initialized

    # 如果已初始化且不是强制重新初始化，直接返回
    if _vector_store_initialized and not force:
        logger.debug("向量数据库已初始化，跳过重复初始化")
        return True

    # 先检查是否已配置
    if not is_vector_db_configured():
        logger.warning("=" * 60)
        logger.warning("向量数据库未配置，跳过初始化")
        logger.warning("请在系统配置中设置 Embedding Provider")
        logger.warning("配置项: embedding.provider 和 embedding.model_name")
        logger.warning("=" * 60)
        _vector_store_initialized = False
        return False

    try:
        if force:
            logger.info("=" * 60)
            logger.info("重新初始化向量数据库...")
            logger.info("=" * 60)
        else:
            logger.info("=" * 60)
            logger.info("开始初始化向量数据库...")
            logger.info("=" * 60)

        config = get_config()

        # 1. 先初始化 Embedder（以便向量存储可以获取实际维度）
        logger.info("步骤 1/3: 预加载嵌入模型...")
        embedder = get_embedder()
        embedder.initialize(config)

        # 检查 Embedder 是否初始化成功
        try:
             # 测试嵌入并获取实际维度
            test_text = "这是一个测试文本"
            test_embedding = embedder.embed(test_text)
            
            # embed 方法现在返回列表，如果是单文本输入，可能返回 list[float]
            # 需要确保我们获取的是向量维度，而不是列表长度
            embedding_dim = 0
            if isinstance(test_embedding, list):
                # 检查是否是嵌套列表 (list[list[float]])
                if len(test_embedding) > 0 and isinstance(test_embedding[0], list):
                    embedding_dim = len(test_embedding[0])
                # 检查是否是单向量 (list[float])
                elif len(test_embedding) > 0 and isinstance(test_embedding[0], float):
                    embedding_dim = len(test_embedding)
                else:
                    logger.warning(f"无法确定向量维度，返回类型: {type(test_embedding)}")
            else:
                 logger.warning(f"embed返回类型异常: {type(test_embedding)}")

            logger.info(f"✓ 嵌入模型已加载 (Provider: {config.embedding.provider})")
            logger.info(f"✓ Provider: {config.embedding.provider}")
            logger.info(f"✓ 模型: {config.embedding.model_name}")
            logger.info(f"✓ 向量维度: {embedding_dim}")
        except Exception as e:
            logger.warning(f"⚠ 嵌入模型初始化失败: {e}")
            logger.warning("向量数据库将跳过初始化")
            _vector_store_initialized = False
            return False

        # 2. 初始化向量数据库客户端（会自动从 Embedder 获取维度）
        logger.info("步骤 2/3: 初始化向量数据库客户端...")
        client = get_vector_client()
        client.initialize(config)
        logger.info(f"✓ 向量数据库客户端已就绪 (后端: {config.vector_store.backend})")

        # 3. 验证集合
        logger.info("步骤 3/3: 验证现有集合...")
        collections = client.list_collections()
        logger.info(f"✓ 找到 {len(collections)} 个向量集合")

        for collection_name in collections:
            try:
                count = client.count_documents(collection_name)
                logger.info(f"  - {collection_name}: {count} 个文档")
            except Exception as e:
                logger.warning(f"  - {collection_name}: 无法获取统计信息 ({e})")

        logger.info("=" * 60)
        logger.info("✅ 向量数据库初始化完成")
        logger.info("=" * 60)

        _vector_store_initialized = True
        return True

    except Exception as e:
        logger.error("=" * 60)
        logger.error(f"❌ 向量数据库初始化失败: {e}")
        logger.error("=" * 60)
        import traceback
        traceback.print_exc()
        _vector_store_initialized = False
        return False


if __name__ == '__main__':
    # 配置日志
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # 执行初始化
    success = init_vector_store()

    if success:
        print("\n✅ 向量数据库已就绪，可以启动应用")
    else:
        print("\n❌ 向量数据库初始化失败，请检查配置")

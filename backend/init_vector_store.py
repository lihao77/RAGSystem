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


def reset_vector_store_initialized():
    """重置向量库初始化标记（配置热重载时调用，使状态与已重置的 embedder/client 一致）。"""
    global _vector_store_initialized
    _vector_store_initialized = False


def is_vector_db_configured():
    """
    检查向量数据库是否已配置（仅看向量库管理中的激活向量化器，不读 config.embedding）。
    """
    try:
        from vector_store.vectorizer_config import get_vectorizer_config_store
        store = get_vectorizer_config_store()
        active = store.get_active_key()
        if not active:
            return False
        return store.get_vectorizer(active) is not None
    except Exception as e:
        logger.error("检查向量数据库配置失败: %s", e)
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

    # 先检查是否已配置（仅向量库管理中的激活向量化器）
    if not is_vector_db_configured():
        logger.warning("=" * 60)
        logger.warning("向量数据库未配置，跳过初始化")
        logger.warning("请在「向量库管理」中添加并激活一个向量化器")
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

        # 1. 先初始化 Embedder（从向量库管理「当前激活向量化器」）
        logger.info("步骤 1/3: 预加载嵌入模型...")
        embedder = get_embedder()
        embedder.initialize(config, force=force)

        from vector_store.vectorizer_config import get_vectorizer_config_store
        store = get_vectorizer_config_store()
        active_key = store.get_active_key()
        active_cfg = store.get_vectorizer(active_key) if active_key else None

        # 检查 Embedder 是否初始化成功
        try:
            test_text = "这是一个测试文本"
            test_embedding = embedder.embed(test_text)

            embedding_dim = 0
            if isinstance(test_embedding, list):
                if len(test_embedding) > 0 and isinstance(test_embedding[0], list):
                    embedding_dim = len(test_embedding[0])
                elif len(test_embedding) > 0 and isinstance(test_embedding[0], float):
                    embedding_dim = len(test_embedding)
                else:
                    logger.warning("无法确定向量维度，返回类型: %s", type(test_embedding))
            else:
                logger.warning("embed 返回类型异常: %s", type(test_embedding))

            logger.info("✓ 嵌入模型已加载 (向量化器: %s)", active_key or "(无)")
            if active_cfg:
                logger.info("✓ Provider: %s, 模型: %s", active_cfg.get("provider_key"), active_cfg.get("model_name"))
            logger.info("✓ 向量维度: %s", embedding_dim)
        except Exception as e:
            logger.warning(f"⚠ 嵌入模型初始化失败: {e}")
            logger.warning("向量数据库将跳过初始化")
            # 失败则不配置文本向量化器：重置 embedder，避免后续使用无效的 _embedder
            try:
                embedder.reset()
            except Exception as reset_err:
                logger.debug(f"重置 Embedder 时: {reset_err}")
            _vector_store_initialized = False
            return False

        # 2. 初始化向量数据库客户端（会自动从 Embedder 获取维度）
        logger.info("步骤 2/3: 初始化向量数据库客户端...")
        client = get_vector_client()
        client.initialize(config, force=force)
        logger.info("✓ 向量数据库客户端已就绪 (后端: %s)", config.vector_store.backend)

        # 2.5 在 DB 的 embedding_models 中注册/绑定当前激活的向量化器，供索引与检索使用
        if active_key and active_cfg:
            try:
                store_obj = client.store
                if hasattr(store_obj, "model_manager"):
                    store_obj.model_manager.register_model(
                        provider=active_cfg.get("provider_key", ""),
                        model_name=active_cfg.get("model_name", ""),
                        vector_dimension=embedder.embedding_dim,
                        distance_metric=active_cfg.get("distance_metric", "cosine"),
                        vectorizer_key=active_key,
                        set_active=True,
                    )
            except Exception as reg_err:
                logger.warning("注册激活向量化器到 model_manager 失败（索引/检索可能受影响）: %s", reg_err)

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

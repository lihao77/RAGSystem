#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
向量数据库启动初始化

在应用启动时预初始化向量数据库，避免首次请求时初始化延迟
"""

import logging
from vector_store import get_vector_client, get_embedder

logger = logging.getLogger(__name__)


def init_vector_store():
    """
    初始化向量数据库
    
    - 创建向量客户端连接
    - 预加载嵌入模型
    - 验证连接状态
    """
    try:
        logger.info("=" * 60)
        logger.info("开始初始化向量数据库...")
        logger.info("=" * 60)
        
        # 1. 初始化向量客户端
        logger.info("步骤 1/3: 初始化向量数据库客户端...")
        client = get_vector_client()
        logger.info("✓ 向量数据库客户端已就绪")
        
        # 2. 预加载嵌入模型
        logger.info("步骤 2/3: 预加载嵌入模型...")
        embedder = get_embedder()
        
        # 测试嵌入
        test_text = "这是一个测试文本"
        test_embedding = embedder.embed_text(test_text)
        logger.info(f"✓ 嵌入模型已加载: {embedder.model_name}")
        logger.info(f"✓ 向量维度: {len(test_embedding)}")
        
        # 3. 验证集合
        logger.info("步骤 3/3: 验证现有集合...")
        collections = client.list_collections()
        logger.info(f"✓ 找到 {len(collections)} 个向量集合")
        
        for collection in collections:
            try:
                stats = collection.count()
                logger.info(f"  - {collection.name}: {stats} 个向量")
            except Exception as e:
                logger.warning(f"  - {collection.name}: 无法获取统计信息 ({e})")
        
        logger.info("=" * 60)
        logger.info("✅ 向量数据库初始化完成")
        logger.info("=" * 60)
        
        return True
        
    except Exception as e:
        logger.error("=" * 60)
        logger.error(f"❌ 向量数据库初始化失败: {e}")
        logger.error("=" * 60)
        import traceback
        traceback.print_exc()
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
        print("\n❌ 向量数据库初始化失败，请检查日志")

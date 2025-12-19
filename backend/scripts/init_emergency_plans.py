#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
应急预案文档初始化脚本
"""

import sys
import os
from pathlib import Path

# 添加backend目录到路径
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

import logging
from vector_store import DocumentIndexer, VectorRetriever

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def load_markdown_file(file_path):
    """加载Markdown文件"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        logger.info(f"成功加载文件: {file_path}")
        logger.info(f"文件大小: {len(content)} 字符")
        return content
    except Exception as e:
        logger.error(f"加载文件失败: {e}")
        raise


def index_emergency_plan(file_path, document_id, chunk_size=500, overlap=50):
    """索引应急预案文档"""
    logger.info(f"=" * 60)
    logger.info(f"开始索引应急预案: {document_id}")
    logger.info(f"=" * 60)
    
    # 1. 加载文档
    logger.info("[1/4] 加载文档...")
    content = load_markdown_file(file_path)
    
    # 2. 初始化索引器
    logger.info("[2/4] 初始化向量索引器...")
    indexer = DocumentIndexer(collection_name="emergency_plans")
    
    # 3. 索引文档
    logger.info(f"[3/4] 文档分块与向量化...")
    logger.info(f"  - 分块大小: {chunk_size} 字符")
    logger.info(f"  - 重叠大小: {overlap} 字符")
    
    metadata = {
        "document_name": Path(file_path).name,
        "document_type": "emergency_plan",
        "source": "广西应急预案",
        "language": "zh"
    }
    
    chunk_count = indexer.index_document(
        document_id=document_id,
        text=content,
        metadata=metadata,
        chunk_size=chunk_size,
        overlap=overlap
    )
    
    # 4. 验证索引
    logger.info(f"[4/4] 验证索引...")
    stats = indexer.get_collection_stats()
    
    logger.info(f"\n索引完成！")
    logger.info(f"  ✅ 文档ID: {document_id}")
    logger.info(f"  ✅ 分块数量: {chunk_count}")
    logger.info(f"  ✅ 向量维度: {stats.get('embedding_dimension', 'N/A')}")
    logger.info(f"  ✅ 模型: {stats.get('model_name', 'N/A')}")
    logger.info(f"  ✅ 集合总分块数: {stats.get('total_chunks', 'N/A')}")
    
    return chunk_count


def test_retrieval(query="Ⅰ级响应启动条件", top_k=3):
    """测试检索功能"""
    logger.info(f"\n" + "=" * 60)
    logger.info(f"测试向量检索")
    logger.info(f"=" * 60)
    logger.info(f"查询: {query}")
    
    retriever = VectorRetriever(collection_name="emergency_plans")
    results = retriever.search(query=query, top_k=top_k)
    
    logger.info(f"\n检索结果 (Top {top_k}):")
    for i, result in enumerate(results, 1):
        logger.info(f"\n【结果 {i}】")
        logger.info(f"  相似度: {result.get('similarity', 0):.4f}")
        logger.info(f"  来源: {result['metadata'].get('document_id', 'unknown')}")
        logger.info(f"  分块: {result['metadata'].get('chunk_index', 0)}/{result['metadata'].get('chunk_total', 0)}")
        logger.info(f"  内容: {result['text'][:200]}...")
    
    return results


def main():
    """主函数"""
    try:
        # 应急预案文档路径（项目根目录）
        project_root = backend_dir.parent
        plan_file = project_root / "广西应急预案.md"
        
        if not plan_file.exists():
            logger.error(f"找不到应急预案文件: {plan_file}")
            logger.error("请确保文件在项目根目录")
            return 1
        
        # 索引文档
        chunk_count = index_emergency_plan(
            file_path=str(plan_file),
            document_id="guangxi_emergency_plan",
            chunk_size=500,
            overlap=50
        )
        
        if chunk_count > 0:
            # 测试检索
            test_retrieval(
                query="Ⅰ级应急响应的启动条件",
                top_k=3
            )
            
            logger.info(f"\n" + "=" * 60)
            logger.info(f"✅ 应急预案初始化完成！")
            logger.info(f"=" * 60)
            logger.info(f"\n下一步:")
            logger.info(f"  1. 在GraphRAG问答中使用 'query_emergency_plan' 工具")
            logger.info(f"  2. 尝试问题: '启动Ⅰ级响应需要什么条件？'")
            logger.info(f"  3. 系统会自动调用向量检索和图谱查询")
            
            return 0
        else:
            logger.error("索引失败，分块数为0")
            return 1
            
    except Exception as e:
        logger.error(f"初始化失败: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())

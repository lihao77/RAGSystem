# -*- coding: utf-8 -*-
"""向量索引节点实现"""

from typing import Dict, Any, Type, List
from pathlib import Path
import logging
import uuid
from datetime import datetime

from nodes.base import INode, NodeDefinition
from .config import VectorIndexerNodeConfig
from vector_store import DocumentIndexer

logger = logging.getLogger(__name__)


class VectorIndexerNode(INode):
    """向量索引节点"""
    
    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type="vector_indexer",
            name="向量索引器",
            description="将文档进行向量化并存储到ChromaDB，支持文本、文件路径、文件ID三种输入方式",
            category="storage",
            version="1.1.0",
            inputs=[
                {"name": "text", "type": "text", "description": "文本内容（直接输入）", "required": False},
                {"name": "file_path", "type": "string", "description": "文件路径（本地文件）", "required": False},
                {"name": "file_id", "type": "string", "description": "文件ID（文件管理系统）", "required": False},
                {"name": "document_id", "type": "string", "description": "文档ID（可选，自动生成）", "required": False}
            ],
            outputs=[
                {"name": "chunk_count", "type": "integer", "description": "分块数量"},
                {"name": "document_id", "type": "string", "description": "文档ID"},
                {"name": "collection_name", "type": "string", "description": "集合名称"}
            ],
            config_schema=VectorIndexerNodeConfig.model_json_schema()
        )
    
    @classmethod
    def get_config_class(cls) -> Type[VectorIndexerNodeConfig]:
        return VectorIndexerNodeConfig
    
    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点
        
        支持三种输入方式：
        1. text: 直接提供文本内容
        2. file_path: 提供文件路径（本地文件）
        3. file_id: 提供文件ID（从文件管理系统读取）
        """
        try:
            import os
            
            # 获取输入
            text = inputs.get('text', '')
            file_path = inputs.get('file_path', '')
            file_id = inputs.get('file_id', '')
            document_id = inputs.get('document_id', '')
            
            # 方式1: 从文件路径读取
            if file_path:
                if not os.path.exists(file_path):
                    return {"success": False, "error": f"文件不存在: {file_path}"}
                
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        text = f.read()
                    
                    # 自动设置 document_id 和元数据
                    if not document_id:
                        document_id = os.path.basename(file_path)
                    
                    logger.info(f"从文件路径读取: {file_path}, 长度: {len(text)}")
                except Exception as e:
                    return {"success": False, "error": f"读取文件失败: {str(e)}"}
            
            # 方式2: 从文件管理系统读取
            elif file_id:
                uploads_path = os.path.join('uploads', file_id)
                
                if not os.path.exists(uploads_path):
                    return {"success": False, "error": f"文件不存在: {file_id}"}
                
                try:
                    with open(uploads_path, 'r', encoding='utf-8') as f:
                        text = f.read()
                    
                    # 自动设置 document_id
                    if not document_id:
                        document_id = file_id
                    
                    logger.info(f"从文件ID读取: {file_id}, 长度: {len(text)}")
                except Exception as e:
                    return {"success": False, "error": f"读取文件失败: {str(e)}"}
            
            # 方式3: 直接提供文本
            elif not text:
                return {
                    "success": False,
                    "error": "必须提供 text、file_path 或 file_id 之一"
                }
            
            # 生成 document_id（如果未提供）
            if not document_id:
                document_id = self._generate_doc_id('doc')
            
            # 创建索引器
            indexer = DocumentIndexer(collection_name=self._config.collection_name)
            
            # 准备元数据
            metadata = {
                "document_type": self._config.document_type,
                "source": self._config.document_source or file_path or file_id or "direct_input",
                "language": self._config.language
            }
            
            if file_path:
                metadata['file_path'] = file_path
            if file_id:
                metadata['file_id'] = file_id
            
            # 检查是否需要覆盖
            if not self._config.overwrite:
                # TODO: 检查文档是否已存在
                pass
            
            # 执行索引
            chunk_count = indexer.index_document(
                document_id=document_id,
                text=text,
                metadata=metadata,
                chunk_size=self._config.chunk_size,
                overlap=self._config.chunk_overlap
            )
            
            logger.info(f"索引成功: {document_id}, 分块数: {chunk_count}")
            
            return {
                "success": True,
                "data": {
                    "chunk_count": chunk_count,
                    "document_id": document_id,
                    "collection_name": self._config.collection_name
                },
                "message": f"成功索引文档，生成 {chunk_count} 个分块"
            }
            
        except Exception as e:
            logger.error(f"向量索引失败: {e}")
            import traceback
            traceback.print_exc()
            return {"success": False, "error": str(e)}
    
    def _generate_doc_id(self, prefix: str) -> str:
        """生成文档ID"""
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        short_uuid = str(uuid.uuid4())[:8]
        return f"{prefix}_{timestamp}_{short_uuid}"

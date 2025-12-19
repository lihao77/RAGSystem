# -*- coding: utf-8 -*-
"""向量索引节点配置"""

from pydantic import Field
from nodes.base import NodeConfigBase


class VectorIndexerNodeConfig(NodeConfigBase):
    """向量索引节点配置"""
    
    collection_name: str = Field(default="documents", description="向量集合名称")
    chunk_size: int = Field(default=500, description="文本分块大小", ge=100, le=2000)
    chunk_overlap: int = Field(default=50, description="分块重叠大小", ge=0, le=500)
    use_jieba: bool = Field(default=True, description="使用jieba优化分块")
    document_type: str = Field(default="general", description="文档类型")
    document_source: str = Field(default="", description="文档来源")
    language: str = Field(default="zh", description="文档语言")
    overwrite: bool = Field(default=False, description="覆盖已存在的文档")

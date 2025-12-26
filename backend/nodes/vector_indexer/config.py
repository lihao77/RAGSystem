# -*- coding: utf-8 -*-
"""向量索引节点配置"""

from pydantic import Field
from nodes.base import NodeConfigBase


class VectorIndexerNodeConfig(NodeConfigBase):
    """向量索引节点配置"""
    
    collection_name: str = Field(
        default="documents", 
        description="向量集合名称",
        json_schema_extra={
            'group': 'default',
            'groupLabel': '基础配置',
            'order': 1,
            'placeholder': 'documents',
            'minLength': 1,
            'maxLength': 100
        }
    )
    
    chunk_size: int = Field(
        default=500, 
        description="文本分块大小", 
        ge=100, 
        le=2000,
        json_schema_extra={
            'group': 'processing',
            'groupLabel': '处理配置',
            'order': 1,
            'minimum': 100,
            'maximum': 2000,
            'multipleOf': 50
        }
    )
    
    chunk_overlap: int = Field(
        default=50, 
        description="分块重叠大小", 
        ge=0, 
        le=500,
        json_schema_extra={
            'group': 'processing',
            'order': 2,
            'minimum': 0,
            'maximum': 500,
            'multipleOf': 10
        }
    )
    
    use_jieba: bool = Field(
        default=True, 
        description="使用jieba优化中文分块",
        json_schema_extra={
            'group': 'processing',
            'order': 3
        }
    )
    
    document_type: str = Field(
        default="general", 
        description="文档类型",
        json_schema_extra={
            'group': 'metadata',
            'groupLabel': '元数据配置',
            'order': 1,
            'options': [
                {'label': '通用文档', 'value': 'general'},
                {'label': '技术文档', 'value': 'technical'},
                {'label': '学术论文', 'value': 'academic'},
                {'label': '新闻报道', 'value': 'news'},
                {'label': '法律文件', 'value': 'legal'},
                {'label': '其他', 'value': 'other'}
            ]
        }
    )
    
    document_source: str = Field(
        default="", 
        description="文档来源",
        json_schema_extra={
            'group': 'metadata',
            'order': 2,
            'placeholder': '例如：官方网站、内部文档等'
        }
    )
    
    language: str = Field(
        default="zh", 
        description="文档语言",
        json_schema_extra={
            'group': 'metadata',
            'order': 3,
            'options': [
                {'label': '中文', 'value': 'zh'},
                {'label': '英文', 'value': 'en'},
                {'label': '日文', 'value': 'ja'},
                {'label': '韩文', 'value': 'ko'},
                {'label': '其他', 'value': 'other'}
            ]
        }
    )
    
    overwrite: bool = Field(
        default=False, 
        description="覆盖已存在的文档（危险操作）",
        json_schema_extra={
            'group': 'advanced',
            'groupLabel': '高级选项',
            'order': 1
        }
    )

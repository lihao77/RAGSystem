# -*- coding: utf-8 -*-
"""
LLMJson 节点配置
"""

from pydantic import Field
from typing import Optional, Dict, Any
from nodes.base import NodeConfigBase


class LLMJsonNodeConfig(NodeConfigBase):
    """llmjson 节点配置"""

    # LLM 配置（使用 LLMConfigSelector）
    llm_config: Dict[str, Any] = Field(
        default_factory=lambda: {
            "provider": "",
            "model_name": "",
            "temperature": 0.7,
            "max_tokens": 4096,
            "timeout": 30,
            "retry_attempts": 3
        },
        description="LLM 配置（从 Adapter 中选择）",
        json_schema_extra={
            'format': 'llm_config',
            'group': 'llm',
            'groupLabel': 'LLM 配置',
            'order': 1,
            'component': 'LLMConfigSelector'  # 使用 LLMConfigSelector 组件
        }
    )

    # 处理参数
    chunk_size: int = Field(
        default=2000, 
        description="文档分块大小",
        json_schema_extra={
            'group': 'processing',
            'groupLabel': '文档处理',
            'order': 1,
            'minimum': 500,
            'maximum': 10000,
            'multipleOf': 100
        }
    )
    
    chunk_overlap: int = Field(
        default=200, 
        description="分块重叠大小",
        json_schema_extra={
            'group': 'processing',
            'order': 2,
            'minimum': 0,
            'maximum': 1000,
            'multipleOf': 50
        }
    )
    
    max_workers: int = Field(
        default=4, 
        description="并行工作线程数",
        json_schema_extra={
            'group': 'processing',
            'order': 3,
            'minimum': 1,
            'maximum': 16
        }
    )
    
    enable_parallel: bool = Field(
        default=True, 
        description="启用并行处理",
        json_schema_extra={
            'group': 'processing',
            'order': 4
        }
    )
    
    # 文档处理
    include_tables: bool = Field(
        default=True, 
        description="处理表格内容",
        json_schema_extra={
            'group': 'processing',
            'order': 5
        }
    )
    
    encoding: str = Field(
        default="utf-8", 
        description="文件编码",
        json_schema_extra={
            'group': 'advanced',
            'order': 3,
            'options': [
                {'label': 'UTF-8', 'value': 'utf-8'},
                {'label': 'GBK', 'value': 'gbk'},
                {'label': 'GB2312', 'value': 'gb2312'},
                {'label': 'ASCII', 'value': 'ascii'}
            ]
        }
    )
    
    # 输出设置
    output_dir: str = Field(
        default="outputs/llmjson", 
        description="输出目录路径",
        json_schema_extra={
            'group': 'output',
            'groupLabel': '输出设置',
            'order': 1,
            'placeholder': 'outputs/llmjson'
        }
    )
    
    save_intermediate: bool = Field(
        default=False, 
        description="保存中间处理结果",
        json_schema_extra={
            'group': 'output',
            'order': 2
        }
    )

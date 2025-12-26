# -*- coding: utf-8 -*-
"""
LLMJson 节点配置
"""

from pydantic import Field
from typing import Optional
from nodes.base import NodeConfigBase


class LLMJsonNodeConfig(NodeConfigBase):
    """llmjson 节点配置"""
    
    # LLM API 配置
    api_key: str = Field(
        default="", 
        description="OpenAI API密钥",
        json_schema_extra={
            'group': 'api',
            'groupLabel': 'API配置',
            'order': 1,
            'format': 'password',
            'placeholder': '请输入API密钥'
        }
    )
    
    base_url: str = Field(
        default="https://api.openai.com/v1", 
        description="API基础URL",
        json_schema_extra={
            'group': 'api',
            'order': 2,
            'placeholder': 'https://api.openai.com/v1'
        }
    )
    
    model: str = Field(
        default="gpt-4o-mini", 
        description="模型名称",
        json_schema_extra={
            'group': 'model',
            'groupLabel': '模型配置',
            'order': 1,
            'options': [
                {'label': 'GPT-4o Mini（推荐）', 'value': 'gpt-4o-mini'},
                {'label': 'GPT-4o', 'value': 'gpt-4o'},
                {'label': 'GPT-4 Turbo', 'value': 'gpt-4-turbo'},
                {'label': 'GPT-3.5 Turbo', 'value': 'gpt-3.5-turbo'}
            ]
        }
    )
    
    # 生成参数
    temperature: float = Field(
        default=0.1, 
        description="生成温度（0-1）",
        json_schema_extra={
            'group': 'model',
            'order': 2,
            'minimum': 0.0,
            'maximum': 1.0,
            'multipleOf': 0.1
        }
    )
    
    max_tokens: int = Field(
        default=4000, 
        description="最大输出token数",
        json_schema_extra={
            'group': 'model',
            'order': 3,
            'minimum': 100,
            'maximum': 128000,
            'multipleOf': 100
        }
    )
    
    timeout: int = Field(
        default=60, 
        description="请求超时时间（秒）",
        json_schema_extra={
            'group': 'advanced',
            'groupLabel': '高级配置',
            'order': 1,
            'minimum': 10,
            'maximum': 300
        }
    )
    
    max_retries: int = Field(
        default=3, 
        description="最大重试次数",
        json_schema_extra={
            'group': 'advanced',
            'order': 2,
            'minimum': 0,
            'maximum': 10
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

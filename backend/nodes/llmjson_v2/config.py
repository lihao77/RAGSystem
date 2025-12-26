# -*- coding: utf-8 -*-
"""
LLMJson v2 节点配置 - 使用内置模板
"""

from pydantic import Field
from typing import Optional
from nodes.base import NodeConfigBase


class LLMJsonV2NodeConfig(NodeConfigBase):
    """llmjson v2 节点配置 - 使用内置模板"""
    
    # === 必需配置 ===
    api_key: str = Field(
        default="", 
        description="OpenAI API密钥",
        json_schema_extra={
            'group': 'api',
            'order': 1,
            'format': 'password',
            'placeholder': '请输入API密钥'
        }
    )
    
    # === 模板选择 ===
    template: str = Field(
        default="universal", 
        description="模板选择",
        json_schema_extra={
            'group': 'template',
            'order': 1,
            'options': [
                {'label': '通用模板', 'value': 'universal'},
                {'label': '洪涝灾害', 'value': 'flood'}
            ]
        }
    )
    
    # === 基础配置 ===
    model: str = Field(
        default="gpt-4o-mini", 
        description="模型名称",
        json_schema_extra={
            'group': 'model',
            'order': 1,
            'options': [
                {'label': 'deepseek-chat', 'value': 'deepseek-chat'},
                {'label': 'GPT-4o', 'value': 'gpt-4o'},
                {'label': 'GPT-4 Turbo', 'value': 'gpt-4-turbo'},
                {'label': 'GPT-3.5 Turbo', 'value': 'gpt-3.5-turbo'}
            ]
        }
    )
    
    base_url: str = Field(
        default="https://api.deepseek.com/v1", 
        description="API基础URL",
        json_schema_extra={
            'group': 'api',
            'order': 2,
            'placeholder': 'https://api.deepseek.com/v1'
        }
    )
    
    temperature: float = Field(
        default=0.1, 
        description="生成温度(0-1)",
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
        description="最大输出长度",
        json_schema_extra={
            'group': 'model',
            'order': 3,
            'minimum': 100,
            'maximum': 128000,
            'multipleOf': 100
        }
    )
    
    # === 文档处理 ===
    chunk_size: int = Field(
        default=2000, 
        description="文档分块大小",
        json_schema_extra={
            'group': 'processing',
            'order': 1,
            'minimum': 500,
            'maximum': 10000,
            'multipleOf': 100
        }
    )
    
    include_tables: bool = Field(
        default=True, 
        description="处理表格内容",
        json_schema_extra={
            'group': 'processing',
            'order': 2
        }
    )
    
    # === 内部参数 ===
    timeout: int = Field(
        default=60, 
        description="请求超时时间（秒）",
        json_schema_extra={
            'group': 'advanced',
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
    
    encoding: str = Field(
        default="utf-8", 
        description="文件编码",
        json_schema_extra={
            'group': 'advanced',
            'order': 3,
            'options': [
                {'label': 'UTF-8', 'value': 'utf-8'},
                {'label': 'GBK', 'value': 'gbk'},
                {'label': 'GB2312', 'value': 'gb2312'}
            ]
        }
    )

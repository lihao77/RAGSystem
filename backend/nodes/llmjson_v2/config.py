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
    api_key: str = Field(default="", description="OpenAI API密钥")
    
    # === 模板选择 ===
    template: str = Field(
        default="universal", 
        description="模板选择: universal(通用), flood(洪涝灾害)"
    )
    
    # === 基础配置 ===
    model: str = Field(default="gpt-4o-mini", description="模型名称")
    base_url: str = Field(default="https://api.openai.com/v1", description="API基础URL")
    temperature: float = Field(default=0.1, description="生成温度(0-1)")
    max_tokens: int = Field(default=4000, description="最大输出长度")
    
    # === 文档处理 ===
    chunk_size: int = Field(default=2000, description="文档分块大小")
    include_tables: bool = Field(default=True, description="处理表格内容")
    
    # === 内部参数 ===
    timeout: int = Field(default=60, description="请求超时时间")
    max_retries: int = Field(default=3, description="最大重试次数")
    encoding: str = Field(default="utf-8", description="文件编码")
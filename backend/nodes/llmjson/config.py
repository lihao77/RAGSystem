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
    api_key: str = Field(default="", description="API密钥")
    base_url: str = Field(default="https://api.openai.com/v1", description="API基础URL")
    model: str = Field(default="gpt-4o-mini", description="模型名称")
    
    # 生成参数
    temperature: float = Field(default=0.1, description="生成温度")
    max_tokens: int = Field(default=4000, description="最大token数")
    timeout: int = Field(default=60, description="超时时间(秒)")
    max_retries: int = Field(default=3, description="最大重试次数")
    
    # 处理参数
    chunk_size: int = Field(default=2000, description="分块大小")
    chunk_overlap: int = Field(default=200, description="分块重叠")
    max_workers: int = Field(default=4, description="并行工作线程数")
    enable_parallel: bool = Field(default=True, description="启用并行处理")
    
    # 文档处理
    include_tables: bool = Field(default=True, description="包含表格")
    encoding: str = Field(default="utf-8", description="文件编码")
    
    # 输出设置
    output_dir: str = Field(default="outputs/llmjson", description="输出目录")
    save_intermediate: bool = Field(default=False, description="保存中间结果")

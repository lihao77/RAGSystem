# -*- coding: utf-8 -*-
"""
Json2Graph 节点配置
"""

from pydantic import Field, BaseModel
from typing import List, Dict, Any, Optional
from nodes.base import NodeConfigBase


class ProcessorConfig(BaseModel):
    """处理器配置"""
    name: str = Field(description="处理器名称")
    class_path: str = Field(description="处理器类路径")
    enabled: bool = Field(default=True, description="是否启用")
    params: Dict[str, Any] = Field(default_factory=dict, description="处理器参数")


class Json2GraphNodeConfig(NodeConfigBase):
    """json2graph 节点配置"""
    
    # Neo4j 连接
    neo4j_uri: str = Field(default="bolt://localhost:7687", description="Neo4j URI")
    neo4j_user: str = Field(default="neo4j", description="Neo4j 用户名")
    neo4j_password: str = Field(default="", description="Neo4j 密码")
    
    # 存储模式
    store_mode: str = Field(
        default="stkg", 
        description="存储模式: skg(基础) 或 stkg(增强)"
    )
    
    # 处理器配置
    processors: List[ProcessorConfig] = Field(
        default_factory=lambda: [
            ProcessorConfig(
                name="SpatialProcessor",
                class_path="json2graph.processor.SpatialProcessor",
                enabled=True,
                params={}
            ),
            ProcessorConfig(
                name="SpatialRelationshipProcessor",
                class_path="json2graph.processor.SpatialRelationshipProcessor",
                enabled=True,
                params={}
            )
        ],
        description="处理器配置列表"
    )
    
    # 执行选项
    clear_before_import: bool = Field(default=False, description="导入前清空数据库")

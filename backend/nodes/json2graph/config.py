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
    neo4j_uri: str = Field(
        default="bolt://localhost:7687", 
        description="Neo4j 数据库URI",
        json_schema_extra={
            'group': 'database',
            'groupLabel': '数据库配置',
            'order': 1,
            'placeholder': 'bolt://localhost:7687'
        }
    )
    
    neo4j_user: str = Field(
        default="neo4j", 
        description="Neo4j 用户名",
        json_schema_extra={
            'group': 'database',
            'order': 2,
            'placeholder': 'neo4j'
        }
    )
    
    neo4j_password: str = Field(
        default="", 
        description="Neo4j 密码",
        json_schema_extra={
            'group': 'database',
            'order': 3,
            'format': 'password',
            'placeholder': '请输入数据库密码'
        }
    )
    
    # 存储模式
    store_mode: str = Field(
        default="stkg", 
        description="存储模式",
        json_schema_extra={
            'group': 'processing',
            'groupLabel': '处理配置',
            'order': 1,
            'options': [
                {'label': 'SKG - 基础模式', 'value': 'skg'},
                {'label': 'STKG - 增强模式（推荐）', 'value': 'stkg'}
            ]
        }
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
        description="处理器配置列表（JSON格式）",
        json_schema_extra={
            'group': 'processing',
            'order': 2,
            'format': 'json',
            'rows': 8
        }
    )
    
    # 执行选项
    clear_before_import: bool = Field(
        default=False, 
        description="导入前清空数据库（危险操作）",
        json_schema_extra={
            'group': 'advanced',
            'groupLabel': '高级选项',
            'order': 1
        }
    )

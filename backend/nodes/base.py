# -*- coding: utf-8 -*-
"""
节点基类 - 最小可执行版本
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, Type, TypeVar
from pydantic import BaseModel, Field
from enum import Enum


class NodeStatus(str, Enum):
    """节点状态"""
    IDLE = "idle"
    RUNNING = "running"
    SUCCESS = "success"
    ERROR = "error"


class NodeConfigBase(BaseModel):
    """节点配置基类"""
    class Config:
        extra = "allow"


class NodeDefinition(BaseModel):
    """节点类型定义"""
    type: str                    # 唯一标识
    name: str                    # 显示名称
    description: str = ""
    category: str = "default"    # 分类
    version: str = "1.0.0"
    
    # 输入输出定义
    inputs: List[Dict[str, Any]] = Field(default_factory=list)
    outputs: List[Dict[str, Any]] = Field(default_factory=list)
    
    # 配置Schema
    config_schema: Dict[str, Any] = Field(default_factory=dict)


# 泛型配置类型
TConfig = TypeVar('TConfig', bound=NodeConfigBase)


class INode(ABC):
    """节点接口"""
    
    def __init__(self):
        self._config: Optional[NodeConfigBase] = None
        self._status: NodeStatus = NodeStatus.IDLE
    
    @classmethod
    @abstractmethod
    def get_definition(cls) -> NodeDefinition:
        """获取节点定义"""
        pass
    
    @classmethod
    @abstractmethod
    def get_config_class(cls) -> Type[NodeConfigBase]:
        """获取配置类"""
        pass
    
    @classmethod
    def get_default_config(cls) -> NodeConfigBase:
        """获取默认配置"""
        return cls.get_config_class()()
    
    def configure(self, config: NodeConfigBase):
        """设置配置"""
        self._config = config
    
    def configure_from_dict(self, config_dict: Dict[str, Any]):
        """从字典设置配置"""
        config_class = self.get_config_class()
        self._config = config_class(**config_dict)
    
    @abstractmethod
    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点"""
        pass
    
    def validate(self) -> List[str]:
        """验证配置"""
        errors = []
        if self._config is None:
            errors.append("节点未配置")
        return errors

# -*- coding: utf-8 -*-
"""
节点基类 - 最小可执行版本
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, Type, TypeVar
from pydantic import BaseModel, Field
from enum import Enum
from pathlib import Path


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

    # 输入约束
    # - exclusive_groups: 互斥组，每组内只能选一个输入
    #   例如: [["file_ids", "files", "text"]] 表示这三个输入只能选一个
    # - required_one_of: 必须至少选一个的输入组
    #   例如: [["file_ids", "files", "text"]] 表示这三个中至少选一个
    input_constraints: Dict[str, Any] = Field(default_factory=dict)

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
    
    @classmethod
    def get_config_schema(cls) -> Dict[str, Any]:
        """获取增强的配置Schema（用于前端表单生成）"""
        from nodes.schema_generator import SchemaGenerator
        return SchemaGenerator.generate(cls.get_config_class())
    
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

    def validate_inputs(self, inputs: Dict[str, Any]) -> List[str]:
        """
        验证节点输入约束

        Args:
            inputs: 输入参数字典

        Returns:
            错误消息列表
        """
        errors = []
        defn = self.get_definition()

        # 获取输入约束
        constraints = defn.input_constraints or {}
        exclusive_groups = constraints.get('exclusive_groups', [])
        required_one_of = constraints.get('required_one_of', [])

        # 验证互斥组
        for group in exclusive_groups:
            provided = [name for name in group if name in inputs and inputs[name] is not None]
            if len(provided) > 1:
                errors.append(f"输入 {'/'.join(group)} 互斥，只能提供其中一个，但提供了: {', '.join(provided)}")

        # 验证必填组
        for group in required_one_of:
            provided = [name for name in group if name in inputs and inputs[name] is not None]
            if not provided:
                errors.append(f"必须提供 {'/'.join(group)} 中的至少一个")

        return errors
    
    def validate_file_ids(self, config_dict: Dict[str, Any]) -> List[str]:
        """
        验证配置中的文件ID是否存在
        
        Args:
            config_dict: 节点配置字典
            
        Returns:
            错误消息列表，如果所有文件ID都有效则返回空列表
        """
        from file_index import FileIndex
        
        errors = []
        file_index = FileIndex()
        
        # 递归查找配置中的所有文件ID字段
        def find_file_ids(obj: Any, path: str = "") -> List[tuple[str, Any]]:
            """查找配置对象中的文件ID字段，返回 (字段路径, 值) 列表"""
            file_id_fields = []
            
            if isinstance(obj, dict):
                for key, value in obj.items():
                    current_path = f"{path}.{key}" if path else key
                    # 检查是否是文件ID字段（字段名包含 file 或 document）
                    if isinstance(value, str) and any(k in key.lower() for k in ['file', 'document', 'upload', 'attachment']):
                        if value:  # 非空字符串
                            file_id_fields.append((current_path, value))
                    elif isinstance(value, list):
                        # 检查是否是文件ID数组
                        if any(k in key.lower() for k in ['file', 'document', 'upload', 'attachment']):
                            for idx, item in enumerate(value):
                                if isinstance(item, str) and item:
                                    file_id_fields.append((f"{current_path}[{idx}]", item))
                        else:
                            # 递归处理列表中的对象
                            for idx, item in enumerate(value):
                                file_id_fields.extend(find_file_ids(item, f"{current_path}[{idx}]"))
                    elif isinstance(value, dict):
                        file_id_fields.extend(find_file_ids(value, current_path))
            
            return file_id_fields
        
        # 查找所有文件ID字段
        file_id_fields = find_file_ids(config_dict)
        
        # 验证每个文件ID
        for field_path, file_id in file_id_fields:
            file_info = file_index.get(file_id)
            if not file_info:
                errors.append(f"配置字段 '{field_path}' 引用的文件ID '{file_id}' 不存在")
            else:
                # 验证物理文件是否存在
                stored_path = file_info.get('stored_path')
                if stored_path:
                    file_path = Path(stored_path)
                    if not file_path.exists():
                        errors.append(f"配置字段 '{field_path}' 引用的文件ID '{file_id}' 在索引中存在，但物理文件不存在: {stored_path}")
        
        return errors
    
    def get_file_metadata(self, file_id: str) -> Optional[Dict[str, Any]]:
        """
        根据文件ID获取文件元数据
        
        Args:
            file_id: 文件ID
            
        Returns:
            文件元数据字典，如果文件不存在则返回 None
            元数据包含: id, original_name, stored_name, stored_path, size, mime, uploaded_at
        """
        from file_index import FileIndex
        
        file_index = FileIndex()
        return file_index.get(file_id)

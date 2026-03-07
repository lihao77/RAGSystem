# -*- coding: utf-8 -*-
"""
节点注册中心
"""

from typing import Dict, Type, List, Optional
from pathlib import Path
import importlib.util

from runtime.dependencies import get_runtime_dependency

from .base import INode, NodeDefinition


class NodeRegistry:
    """节点注册中心 - 单例模式"""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._nodes: Dict[str, Type[INode]] = {}
        return cls._instance
    
    def register(self, node_class: Type[INode]):
        """注册节点"""
        definition = node_class.get_definition()
        self._nodes[definition.type] = node_class
        print(f"[NodeRegistry] 注册节点: {definition.type} ({definition.name})")
    
    def get(self, node_type: str) -> Type[INode]:
        """获取节点类"""
        if node_type not in self._nodes:
            raise KeyError(f"节点类型 '{node_type}' 未注册")
        return self._nodes[node_type]
    
    def list_all(self) -> List[NodeDefinition]:
        """列出所有节点定义"""
        return [cls.get_definition() for cls in self._nodes.values()]
    
    def list_types(self) -> List[str]:
        """列出所有节点类型"""
        return list(self._nodes.keys())
    
    def create_instance(self, node_type: str) -> INode:
        """创建节点实例"""
        node_class = self.get(node_type)
        return node_class()
    
    def scan_and_register(self, nodes_dir: str = None):
        """扫描目录自动注册节点"""
        if nodes_dir is None:
            nodes_dir = Path(__file__).parent
        else:
            nodes_dir = Path(nodes_dir)
        
        for node_dir in nodes_dir.iterdir():
            if not node_dir.is_dir():
                continue
            if node_dir.name.startswith("_") or node_dir.name == "__pycache__":
                continue
            
            node_file = node_dir / "node.py"
            if not node_file.exists():
                continue
            
            try:
                spec = importlib.util.spec_from_file_location(
                    f"nodes.{node_dir.name}.node",
                    node_file
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                
                # 查找 INode 子类
                for attr_name in dir(module):
                    attr = getattr(module, attr_name)
                    if (isinstance(attr, type) and 
                        issubclass(attr, INode) and 
                        attr is not INode and
                        hasattr(attr, 'get_definition')):
                        self.register(attr)
                        
            except Exception as e:
                print(f"[NodeRegistry] 加载节点 {node_dir.name} 失败: {e}")


_node_registry: Optional[NodeRegistry] = None


def create_initialized_registry() -> NodeRegistry:
    registry = NodeRegistry()
    if not registry.list_types():
        registry.scan_and_register()
    return registry


def get_registry() -> NodeRegistry:
    """获取注册中心实例。"""
    return get_runtime_dependency(
        container_getter='get_node_registry',
        fallback_name='node_registry',
        fallback_factory=create_initialized_registry,
        require_container=True,
    )


def init_registry() -> NodeRegistry:
    """初始化并扫描节点。"""
    return get_registry()

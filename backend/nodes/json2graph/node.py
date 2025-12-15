# -*- coding: utf-8 -*-
"""
Json2Graph 节点实现
"""

from typing import Dict, Any, Type, List
import importlib

from nodes.base import INode, NodeDefinition
from .config import Json2GraphNodeConfig, ProcessorConfig


class Json2GraphNode(INode):
    """Json2Graph节点 - JSON到图谱存储"""
    
    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type="json2graph",
            name="图谱存储",
            description="将JSON结构化数据存储到Neo4j知识图谱",
            category="output",
            version="1.0.0",
            inputs=[
                {"name": "json_data", "type": "json", "description": "JSON数据", "required": True}
            ],
            outputs=[
                {"name": "stats", "type": "json", "description": "存储统计"},
                {"name": "success", "type": "bool", "description": "是否成功"}
            ],
            config_schema=Json2GraphNodeConfig.model_json_schema()
        )
    
    @classmethod
    def get_config_class(cls) -> Type[Json2GraphNodeConfig]:
        return Json2GraphNodeConfig
    
    def validate(self) -> List[str]:
        """验证配置"""
        errors = super().validate()
        if self._config and not self._config.neo4j_password:
            errors.append("Neo4j密码不能为空")
        return errors
    
    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点"""
        try:
            from json2graph import Neo4jConnection, SKGStore, STKGStore
        except ImportError:
            return {
                "stats": {"error": "json2graph 包未安装"},
                "success": False
            }
        
        config = self._config
        
        # 连接数据库
        db = Neo4jConnection(
            uri=config.neo4j_uri,
            user=config.neo4j_user,
            password=config.neo4j_password
        )
        
        try:
            db.connect()
            
            # 选择存储模式
            if config.store_mode == "stkg":
                store = STKGStore(db)
            else:
                store = SKGStore(db)
            
            # 加载额外处理器（stkg已内置空间处理器）
            if config.store_mode != "stkg":
                self._load_processors(store, config.processors)
            
            # 获取输入数据
            json_data = inputs.get("json_data", {})
            
            # 清空数据库（如果配置）
            if config.clear_before_import:
                db.run("MATCH (n) DETACH DELETE n")
            
            # 存储数据
            store.store_knowledge_graph(json_data)
            
            stats = {
                "base_entities": len(json_data.get("基础实体", [])),
                "state_entities": len(json_data.get("状态实体", [])),
                "state_relations": len(json_data.get("状态关系", [])),
                "processors_applied": [p.get_name() for p in store.get_processors()]
            }
            
            return {"stats": stats, "success": True}
            
        except Exception as e:
            return {"stats": {"error": str(e)}, "success": False}
        finally:
            db.close()
    
    def _load_processors(self, store, processors: List[ProcessorConfig]):
        """加载处理器"""
        for proc_config in processors:
            if not proc_config.enabled:
                continue
            
            try:
                module_path, class_name = proc_config.class_path.rsplit(".", 1)
                module = importlib.import_module(module_path)
                processor_class = getattr(module, class_name)
                processor = processor_class(**proc_config.params)
                store.add_processor(processor)
            except Exception as e:
                print(f"[Json2GraphNode] 加载处理器 {proc_config.name} 失败: {e}")
    
    # ========== 处理器管理便捷方法 ==========
    
    def add_processor(self, name: str, class_path: str, params: Dict = None):
        """添加处理器配置"""
        if self._config is None:
            self.configure(self.get_default_config())
        
        self._config.processors.append(ProcessorConfig(
            name=name,
            class_path=class_path,
            enabled=True,
            params=params or {}
        ))
    
    def remove_processor(self, name: str) -> bool:
        """移除处理器配置"""
        if self._config is None:
            return False
        
        original_len = len(self._config.processors)
        self._config.processors = [
            p for p in self._config.processors if p.name != name
        ]
        return len(self._config.processors) < original_len
    
    def list_processors(self) -> List[Dict[str, Any]]:
        """列出配置的处理器"""
        if self._config is None:
            return []
        return [p.model_dump() for p in self._config.processors]
    
    @staticmethod
    def get_builtin_processors() -> List[Dict[str, str]]:
        """获取内置处理器列表"""
        return [
            {
                "name": "SpatialProcessor",
                "class_path": "json2graph.processor.SpatialProcessor",
                "description": "处理地点实体的空间属性"
            },
            {
                "name": "SpatialRelationshipProcessor",
                "class_path": "json2graph.processor.SpatialRelationshipProcessor",
                "description": "构建空间层级关系"
            }
        ]

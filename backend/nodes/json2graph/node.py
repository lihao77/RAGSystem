# -*- coding: utf-8 -*-
"""
Json2Graph 节点实现。
"""

from typing import Any, Dict, List, Type

from integrations.errors import IntegrationError
from integrations.json2graph import Json2GraphAdapter, Json2GraphIntegrationError
from nodes.base import INode, NodeDefinition
from .config import Json2GraphNodeConfig, ProcessorConfig


class Json2GraphNode(INode):
    """Json2Graph 节点 - JSON 到图谱存储。"""

    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type='json2graph',
            name='图谱存储',
            description='将JSON结构化数据存储到Neo4j知识图谱',
            category='output',
            version='1.0.0',
            inputs=[
                {'name': 'json_data', 'type': 'json', 'description': 'JSON数据', 'required': True},
            ],
            outputs=[
                {'name': 'stats', 'type': 'json', 'description': '存储统计'},
                {'name': 'success', 'type': 'bool', 'description': '是否成功'},
            ],
            config_schema=Json2GraphNodeConfig.model_json_schema(),
        )

    @classmethod
    def get_config_class(cls) -> Type[Json2GraphNodeConfig]:
        return Json2GraphNodeConfig

    def validate(self) -> List[str]:
        """验证配置。"""
        errors = super().validate()
        if self._config and not self._config.neo4j_password:
            errors.append('Neo4j密码不能为空')
        return errors

    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点。"""
        try:
            stats = Json2GraphAdapter(self._config).store_knowledge_graph(inputs.get('json_data', {}))
            return {'stats': stats, 'success': True}
        except (IntegrationError, Json2GraphIntegrationError) as error:
            return {'stats': {'error': str(error)}, 'success': False}
        except Exception as error:
            return {'stats': {'error': str(error)}, 'success': False}

    def add_processor(self, name: str, class_path: str, params: Dict = None):
        """添加处理器配置。"""
        if self._config is None:
            self.configure(self.get_default_config())

        self._config.processors.append(ProcessorConfig(
            name=name,
            class_path=class_path,
            enabled=True,
            params=params or {},
        ))

    def remove_processor(self, name: str) -> bool:
        """移除处理器配置。"""
        if self._config is None:
            return False

        original_len = len(self._config.processors)
        self._config.processors = [
            processor for processor in self._config.processors if processor.name != name
        ]
        return len(self._config.processors) < original_len

    def list_processors(self) -> List[Dict[str, Any]]:
        """列出配置的处理器。"""
        if self._config is None:
            return []
        return [processor.model_dump() for processor in self._config.processors]

    @staticmethod
    def get_builtin_processors() -> List[Dict[str, str]]:
        """获取内置处理器列表。"""
        return [
            {
                'name': 'SpatialProcessor',
                'class_path': 'json2graph.processor.SpatialProcessor',
                'description': '处理地点实体的空间属性',
            },
            {
                'name': 'SpatialRelationshipProcessor',
                'class_path': 'json2graph.processor.SpatialRelationshipProcessor',
                'description': '构建空间层级关系',
            },
        ]

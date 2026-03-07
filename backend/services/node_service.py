# -*- coding: utf-8 -*-
"""
节点系统服务层。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from runtime.dependencies import get_runtime_dependency
from nodes import get_node_config_store, init_registry

logger = logging.getLogger(__name__)


class NodeServiceError(Exception):
    """节点系统业务异常。"""

    def __init__(self, message: str, status_code: int = 400, **payload: Any):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload


class NodeService:
    """封装节点定义、配置与执行逻辑。"""

    def __init__(self, registry=None, config_store=None):
        self._registry = registry or init_registry()
        self._config_store = config_store or get_node_config_store()

    def list_node_types(self):
        return [definition.model_dump() for definition in self._registry.list_all()]

    def get_node_type(self, node_type: str) -> Dict[str, Any]:
        node_class = self._get_node_class(node_type)
        return node_class.get_definition().model_dump()

    def get_default_config(self, node_type: str) -> Dict[str, Any]:
        node_class = self._get_node_class(node_type)
        return node_class.get_default_config().model_dump()

    def get_config_schema(self, node_type: str) -> Dict[str, Any]:
        node_class = self._get_node_class(node_type)
        return node_class.get_config_schema()

    def get_data_types(self) -> Dict[str, Any]:
        definitions = self._registry.list_all()
        types_set = set()
        for definition in definitions:
            for input_def in definition.inputs:
                if 'type' in input_def:
                    types_set.add(input_def['type'])
            for output_def in definition.outputs:
                if 'type' in output_def:
                    types_set.add(output_def['type'])

        types_list = sorted(types_set)
        common_types = ['any', 'text', 'string', 'integer', 'number', 'bool', 'json', 'array', 'object', 'file_id', 'file_ids']
        additional = [item for item in common_types if item not in types_set]
        types_list.extend(additional)
        return {
            'types': types_list,
            'count': len(types_list),
            'from_nodes': sorted(types_set),
            'additional': additional,
        }

    def list_configs(self, node_type: Optional[str], include_presets: bool):
        configs = self._config_store.list_configs(node_type, include_presets)
        return [config.model_dump() for config in configs]

    def save_config(self, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = data or {}
        node_type = payload.get('node_type')
        name = payload.get('name')
        config_data = payload.get('config', {})
        description = payload.get('description', '')
        tags = payload.get('tags', [])
        is_preset = payload.get('is_preset', False)
        overwrite = payload.get('overwrite', False)

        if not node_type:
            raise NodeServiceError('缺少 node_type', status_code=400)
        if not name:
            raise NodeServiceError('缺少 name', status_code=400)

        node_class = self._get_node_class(node_type)
        try:
            config = node_class.get_config_class()(**config_data)
        except Exception as error:
            raise NodeServiceError(f'配置验证失败: {error}', status_code=400) from error

        if (not is_preset) and (not overwrite):
            existing = self._config_store.find_instance_by_name(node_type, name)
            if existing:
                raise NodeServiceError(
                    '配置名称已存在，是否覆盖？',
                    status_code=409,
                    exists=True,
                    config_id=existing['metadata'].id,
                )

        config_id = self._config_store.save_config(
            node_type=node_type,
            config=config,
            name=name,
            description=description,
            tags=tags,
            is_preset=is_preset,
            overwrite=overwrite,
        )
        return {
            'config_id': config_id,
            'overwritten': overwrite,
        }

    def get_config(self, config_id: str) -> Dict[str, Any]:
        data = self._config_store.load_config_with_metadata(config_id)
        if not data:
            raise NodeServiceError('配置不存在', status_code=404)
        return {
            'metadata': data.get('_metadata', {}),
            'config': data.get('config', {}),
        }

    def delete_config(self, config_id: str) -> None:
        success = self._config_store.delete_config(config_id)
        if not success:
            raise NodeServiceError('配置不存在', status_code=404)

    def execute_node(self, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = data or {}
        node_type = payload.get('node_type')
        config_id = payload.get('config_id')
        config_data = payload.get('config')
        inputs = payload.get('inputs', {})

        if not node_type:
            raise NodeServiceError('缺少 node_type', status_code=400)

        node_class = self._get_node_class(node_type)
        node = node_class()

        if config_id:
            config = self._config_store.load_config(config_id, node_class)
            if not config:
                raise NodeServiceError('配置不存在', status_code=404)
            node.configure(config)
        elif config_data:
            node.configure_from_dict(config_data)
        else:
            node.configure(node_class.get_default_config())

        errors = node.validate()
        if errors:
            raise NodeServiceError('配置验证失败', status_code=400, details=errors)

        try:
            return node.execute(inputs)
        except Exception as error:
            raise NodeServiceError(str(error), status_code=500) from error

    def list_builtin_processors(self):
        from nodes.json2graph import Json2GraphNode

        return Json2GraphNode.get_builtin_processors()

    def _get_node_class(self, node_type: str):
        try:
            return self._registry.get(node_type)
        except KeyError as error:
            raise NodeServiceError(f'节点类型 {node_type} 不存在', status_code=404) from error


_node_service: Optional[NodeService] = None



def get_node_service() -> NodeService:
    global _node_service
    return get_runtime_dependency(
        container_getter='get_node_service',
        fallback_name='node_service',
        fallback_factory=NodeService,
        require_container=True,
        legacy_getter=lambda: _node_service,
        legacy_setter=lambda instance: globals().__setitem__('_node_service', instance),
    )

# -*- coding: utf-8 -*-
"""
json2graph 集成适配器。

收口外部 json2graph 包的导入、连接和处理器装载逻辑。
"""

from __future__ import annotations

import importlib
from typing import Any, Dict, List

from integrations.errors import DependencyNotAvailableError, ExternalServiceError

logger_name = __name__


class Json2GraphIntegrationError(ExternalServiceError):
    """json2graph 集成异常。"""


class Json2GraphAdapter:
    """json2graph 外部依赖适配器。"""

    def __init__(self, config):
        self._config = config
        self._runtime = self._load_runtime()

    def store_knowledge_graph(self, json_data: Dict[str, Any]) -> Dict[str, Any]:
        db = self._runtime['Neo4jConnection'](
            uri=self._config.neo4j_uri,
            user=self._config.neo4j_user,
            password=self._config.neo4j_password,
        )

        try:
            db.connect()

            if self._config.clear_before_import:
                db.get_session().run('MATCH (n) DETACH DELETE n')

            if self._config.store_mode == 'stkg':
                store = self._runtime['STKGStore'](db)
            else:
                store = self._runtime['SKGStore'](db)
                self._load_processors(store, self._config.processors)

            store.store_knowledge_graph(json_data)

            processors = []
            if hasattr(store, 'get_processors'):
                try:
                    processors = [processor.get_name() for processor in store.get_processors()]
                except Exception:
                    processors = []

            return {
                'base_entities': len(json_data.get('基础实体', [])),
                'state_entities': len(json_data.get('状态实体', [])),
                'state_relations': len(json_data.get('状态关系', [])),
                'processors_applied': processors,
            }
        except Json2GraphIntegrationError:
            raise
        except Exception as error:
            raise Json2GraphIntegrationError(str(error)) from error
        finally:
            try:
                db.close()
            except Exception:
                pass

    def _load_processors(self, store, processors: List[Any]) -> None:
        for processor_config in processors:
            if not processor_config.enabled:
                continue

            try:
                module_path, class_name = processor_config.class_path.rsplit('.', 1)
                module = importlib.import_module(module_path)
                processor_class = getattr(module, class_name)
                processor = processor_class(**processor_config.params)
                store.add_processor(processor)
            except Exception as error:
                raise Json2GraphIntegrationError(
                    f'加载处理器 {processor_config.name} 失败: {error}'
                ) from error

    @staticmethod
    def _load_runtime() -> Dict[str, Any]:
        try:
            module = importlib.import_module('json2graph')
        except ImportError as error:
            raise DependencyNotAvailableError('json2graph 包未安装') from error

        try:
            return {
                'Neo4jConnection': getattr(module, 'Neo4jConnection'),
                'SKGStore': getattr(module, 'SKGStore'),
                'STKGStore': getattr(module, 'STKGStore'),
            }
        except AttributeError as error:
            raise Json2GraphIntegrationError(f'json2graph 接口不完整: {error}') from error

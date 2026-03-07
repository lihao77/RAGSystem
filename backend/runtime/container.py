# -*- coding: utf-8 -*-
"""
运行时容器。

集中管理进程级运行时对象，逐步替代分散在各模块中的全局单例。
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

_current_runtime_container: Optional['RuntimeContainer'] = None
_current_runtime_container_lock = threading.RLock()


class RuntimeContainer:
    """进程级运行时容器。"""

    def __init__(self):
        self._instances: Dict[str, Any] = {}
        self._lock = threading.RLock()
        self.app = None

    def init_app(self, app) -> 'RuntimeContainer':
        """绑定到 Flask app，并暴露到 `app.extensions`。"""
        self.app = app
        extensions = getattr(app, 'extensions', None)
        if extensions is None:
            app.extensions = {}
        app.extensions['runtime_container'] = self
        set_current_runtime_container(self)
        return self

    def get_config_manager(self):
        from config.base import ConfigManager

        return self._get_or_create('config_manager', ConfigManager)

    def get_agent_config_manager(self):
        from agents.config.manager import AgentConfigManager

        return self._get_or_create('agent_config_manager', AgentConfigManager)

    def get_model_adapter(self):
        from model_adapter.adapter import ModelAdapter

        return self._get_or_create('model_adapter', ModelAdapter)

    def set_model_adapter(self, adapter) -> None:
        self.set_instance('model_adapter', adapter)

    def get_mcp_manager(self):
        from mcp.client_manager import MCPClientManager

        return self._get_or_create('mcp_manager', MCPClientManager)

    def get_mcp_service(self):
        from services.mcp_service import MCPService

        return self._get_or_create('mcp_service', MCPService)

    def get_model_adapter_service(self):
        from services.model_adapter_service import ModelAdapterService

        return self._get_or_create('model_adapter_service', ModelAdapterService)

    def get_agent_runtime_service(self):
        from services.agent_runtime_service import AgentRuntimeService

        return self._get_or_create('agent_runtime_service', AgentRuntimeService)

    def get_agent_config_service(self):
        from services.agent_config_service import AgentConfigService

        return self._get_or_create('agent_config_service', AgentConfigService)

    def get_node_service(self):
        from services.node_service import NodeService

        return self._get_or_create('node_service', NodeService)

    def get_workflow_service(self):
        from services.workflow_service import WorkflowService

        return self._get_or_create('workflow_service', WorkflowService)

    def get_vector_library_service(self):
        from services.vector_library_service import VectorLibraryService

        return self._get_or_create('vector_library_service', VectorLibraryService)

    def get_agent_api_runtime_service(self):
        from services.agent_api_runtime_service import AgentApiRuntimeService

        return self._get_or_create('agent_api_runtime_service', AgentApiRuntimeService)

    def get_embedding_model_service(self):
        from services.embedding_model_service import EmbeddingModelService

        return self._get_or_create('embedding_model_service', EmbeddingModelService)

    def get_vector_management_service(self):
        from services.vector_management_service import VectorManagementService

        return self._get_or_create('vector_management_service', VectorManagementService)

    def get_graphrag_api_service(self):
        from services.graphrag_api_service import GraphRAGApiService

        return self._get_or_create('graphrag_api_service', GraphRAGApiService)

    def get_function_call_service(self):
        from services.function_call_service import FunctionCallService

        return self._get_or_create('function_call_service', FunctionCallService)

    def get_home_service(self):
        from services.home_service import HomeService

        return self._get_or_create('home_service', HomeService)

    def get_query_service(self):
        from services.query_service import QueryService

        return self._get_or_create('query_service', QueryService)

    def get_search_service(self):
        from services.search_service import SearchService

        return self._get_or_create('search_service', SearchService)

    def get_config_service(self):
        from services.config_service import ConfigService

        return self._get_or_create('config_service', ConfigService)

    def get_visualization_service(self):
        from services.visualization_service import VisualizationService

        return self._get_or_create('visualization_service', VisualizationService)

    def get_graphrag_service(self):
        from services.graphrag_service import GraphRAGService

        return self._get_or_create('graphrag_service', GraphRAGService)

    def get_neo4j_connection(self):
        from db import Neo4jConnection

        return self._get_or_create('neo4j_connection', Neo4jConnection)

    def startup_mcp(self) -> None:
        self.get_mcp_manager().startup()

    def shutdown(self) -> None:
        """统一关闭容器中已创建的运行时资源。"""
        mcp_manager = self._instances.get('mcp_manager')
        if mcp_manager is not None:
            try:
                mcp_manager.shutdown()
            except Exception as error:
                logger.warning('关闭 MCP 管理器失败: %s', error)

        neo4j_connection = self._instances.get('neo4j_connection')
        if neo4j_connection is not None:
            try:
                neo4j_connection.close()
            except Exception as error:
                logger.warning('关闭 Neo4j 连接失败: %s', error)

    def set_instance(self, key: str, instance: Any) -> Any:
        with self._lock:
            self._instances[key] = instance
        return instance

    def get_instance(self, key: str) -> Any:
        with self._lock:
            return self._instances.get(key)

    def _get_or_create(self, key: str, factory: Callable[[], Any]) -> Any:
        instance = self.get_instance(key)
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get(key)
            if instance is None:
                instance = factory()
                self._instances[key] = instance
            return instance



def create_runtime_container() -> RuntimeContainer:
    container = RuntimeContainer()
    set_current_runtime_container(container)
    return container



def get_current_runtime_container() -> Optional[RuntimeContainer]:
    with _current_runtime_container_lock:
        return _current_runtime_container



def set_current_runtime_container(container: Optional[RuntimeContainer]) -> None:
    global _current_runtime_container
    with _current_runtime_container_lock:
        _current_runtime_container = container

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

    def get_mcp_config_store(self):
        from mcp.config_store import MCPConfigStore

        return self._get_or_create('mcp_config_store', MCPConfigStore)

    def get_mcp_manager(self):
        from mcp.client_manager import MCPClientManager

        instance = self.get_instance('mcp_manager')
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get('mcp_manager')
            if instance is None:
                instance = MCPClientManager(store=self.get_mcp_config_store())
                self._instances['mcp_manager'] = instance
            return instance

    def get_mcp_execution_adapter(self):
        from execution.adapters.mcp_execution import MCPExecutionAdapter

        instance = self.get_instance('mcp_execution_adapter')
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get('mcp_execution_adapter')
            if instance is None:
                instance = MCPExecutionAdapter(execution_service=self.get_execution_service())
                self._instances['mcp_execution_adapter'] = instance
            return instance

    def get_mcp_service(self):
        from services.mcp_service import MCPService

        instance = self.get_instance('mcp_service')
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get('mcp_service')
            if instance is None:
                instance = MCPService(
                    store=self.get_mcp_config_store(),
                    manager=self.get_mcp_manager(),
                    execution_adapter=self.get_mcp_execution_adapter(),
                )
                self._instances['mcp_service'] = instance
            return instance

    def get_in_process_execution_runner(self):
        from execution.in_process_runner import InProcessExecutionRunner

        return self._get_or_create('in_process_execution_runner', InProcessExecutionRunner)

    def get_execution_service(self):
        from services.execution_service import ExecutionService

        instance = self.get_instance('execution_service')
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get('execution_service')
            if instance is None:
                instance = ExecutionService(
                    task_registry=self.get_task_registry(),
                    session_manager=self.get_session_manager(),
                    runner=self.get_in_process_execution_runner(),
                )
                self._instances['execution_service'] = instance
            return instance

    def get_model_adapter_service(self):
        from services.model_adapter_service import ModelAdapterService

        return self._get_or_create('model_adapter_service', ModelAdapterService)

    def get_agent_config_service(self):
        from services.agent_config_service import AgentConfigService

        return self._get_or_create('agent_config_service', AgentConfigService)

    def get_agent_session_application(self):
        from application.agent_session import AgentSessionApplication

        return self._get_or_create('agent_session_application', AgentSessionApplication)

    def get_agent_collaboration_application(self):
        from application.agent_collaboration import AgentCollaborationApplication

        return self._get_or_create('agent_collaboration_application', AgentCollaborationApplication)

    def get_vector_library_service(self):
        from services.vector_library_service import VectorLibraryService

        return self._get_or_create('vector_library_service', VectorLibraryService)

    def get_document_retrieval_capability(self):
        from capabilities.document_retrieval import DocumentRetrievalCapability

        return self._get_or_create('document_retrieval_capability', DocumentRetrievalCapability)

    def get_vector_retrieval_capability(self):
        from capabilities.vector_retrieval import VectorRetrievalCapability

        return self._get_or_create('vector_retrieval_capability', VectorRetrievalCapability)

    def get_mcp_tools_capability(self):
        from capabilities.mcp_tools import MCPToolsCapability

        return self._get_or_create('mcp_tools_capability', MCPToolsCapability)

    def get_agent_api_runtime_service(self):
        from services.agent_api_runtime_service import AgentApiRuntimeService

        return self._get_or_create('agent_api_runtime_service', AgentApiRuntimeService)

    def get_embedding_model_service(self):
        from services.embedding_model_service import EmbeddingModelService

        return self._get_or_create('embedding_model_service', EmbeddingModelService)

    def get_vector_management_service(self):
        from services.vector_management_service import VectorManagementService

        return self._get_or_create('vector_management_service', VectorManagementService)

    def get_task_registry(self):
        from agents.task_registry import TaskRegistry

        return self._get_or_create('task_registry', TaskRegistry)

    def get_session_manager(
        self,
        *,
        session_ttl: int = 3600,
        cleanup_interval: int = 300,
        enable_persistence: bool = True,
        max_history: int = 1000,
    ):
        from agents.events.session_manager import SessionEventBusManager

        instance = self.get_instance('session_manager')
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get('session_manager')
            if instance is None:
                instance = SessionEventBusManager(
                    session_ttl=session_ttl,
                    cleanup_interval=cleanup_interval,
                    enable_persistence=enable_persistence,
                    max_history=max_history,
                )
                self._instances['session_manager'] = instance
            return instance

    def get_event_bus(self, *, enable_persistence: bool = False, max_history: int = 1000):
        from agents.events.bus import EventBus

        instance = self.get_instance('event_bus')
        if instance is not None:
            return instance

        with self._lock:
            instance = self._instances.get('event_bus')
            if instance is None:
                instance = EventBus(
                    enable_persistence=enable_persistence,
                    max_history=max_history,
                )
                self._instances['event_bus'] = instance
            return instance

    def startup_mcp(self) -> None:
        self.get_mcp_manager().startup()

    def shutdown(self) -> None:
        """统一关闭容器中已创建的运行时资源。"""
        session_manager = self._instances.get('session_manager')
        if session_manager is not None:
            try:
                session_manager.shutdown()
            except Exception as error:
                logger.warning('关闭会话事件总线管理器失败: %s', error)

        event_bus = self._instances.get('event_bus')
        if event_bus is not None:
            try:
                event_bus.clear_history()
            except Exception as error:
                logger.warning('清理全局事件总线历史失败: %s', error)

        mcp_manager = self._instances.get('mcp_manager')
        if mcp_manager is not None:
            try:
                mcp_manager.shutdown()
            except Exception as error:
                logger.warning('关闭 MCP 管理器失败: %s', error)


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

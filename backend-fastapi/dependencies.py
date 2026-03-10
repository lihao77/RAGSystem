# -*- coding: utf-8 -*-
"""
FastAPI 全局依赖注入。

所有依赖统一从 RuntimeContainer 获取。
"""

from fastapi import Depends
from runtime.container import get_current_runtime_container


def _container():
    c = get_current_runtime_container()
    if c is None:
        raise RuntimeError('RuntimeContainer 未初始化')
    return c


def get_agent_runtime_service():
    return _container().get_agent_api_runtime_service()


def get_orchestrator(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_orchestrator()


def get_conversation_store(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_conversation_store()


def get_config_manager(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_config_manager()


def get_system_config(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_system_config()


def get_default_adapter(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_default_adapter()


def get_session_application(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_session_application()


def get_collaboration_application(runtime=Depends(get_agent_runtime_service)):
    return runtime.get_collaboration_application()


def get_task_registry(runtime=None):
    if runtime is None:
        runtime = get_agent_runtime_service()
    return runtime.get_task_registry()


def get_execution_service():
    return _container().get_execution_service()


def get_session_event_bus(session_id: str):
    return _container().get_agent_api_runtime_service().get_session_event_bus(session_id)


def get_agent_config_service():
    return _container().get_agent_config_service()


def get_model_adapter_service():
    return _container().get_model_adapter_service()


def get_mcp_tools_capability():
    return _container().get_mcp_tools_capability()


def get_vector_retrieval_capability():
    return _container().get_vector_retrieval_capability()


def get_file_index():
    from file_index import FileIndex
    return FileIndex()

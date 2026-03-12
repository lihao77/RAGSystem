# -*- coding: utf-8 -*-
"""
Agent 管理 API 路由。
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException

from dependencies import (
    get_orchestrator,
    get_config_manager,
    get_system_config,
    get_default_adapter,
)
from schemas.agent import CreateAgentRequest
from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get('/agents')
async def list_agents(orchestrator=Depends(get_orchestrator)):
    """列出所有可用智能体。"""
    try:
        import asyncio
        agents = await asyncio.to_thread(orchestrator.list_agents)
        return ok(data=agents, message=f'共有 {len(agents)} 个智能体')
    except Exception as e:
        logger.error('获取智能体列表失败: %s', e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/agents/create')
async def create_agent(
    data: CreateAgentRequest,
    orchestrator=Depends(get_orchestrator),
    config_manager=Depends(get_config_manager),
    system_config=Depends(get_system_config),
    default_adapter=Depends(get_default_adapter),
):
    """创建新智能体。"""
    try:
        agent_name = data.agent_name
        if not agent_name:
            raise HTTPException(status_code=400, detail='智能体名称不能为空')

        # 检查是否已存在
        if config_manager.get_config(agent_name):
            raise HTTPException(status_code=400, detail=f'智能体 {agent_name} 已存在')

        from agents.config import AgentConfig
        try:
            config = AgentConfig(**data.model_dump(exclude_none=True))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f'配置验证失败: {e}')

        config_manager.set_config(config, save=True)

        # 动态加载新智能体
        try:
            from agents.config import AgentLoader
            loader = AgentLoader(
                model_adapter=default_adapter,
                system_config=system_config,
                orchestrator=orchestrator,
            )
            new_agent = loader.load_agent(agent_name)
            if new_agent:
                orchestrator.register_agent(new_agent)
                logger.info('新智能体 %s 已创建并加载', agent_name)
            else:
                logger.warning('智能体 %s 配置已保存但在加载时失败', agent_name)
        except Exception as e:
            logger.error('热加载新智能体失败: %s', e)

        return ok(data=config.model_dump(), message=f'智能体 {agent_name} 创建成功')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('创建智能体失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete('/agents/delete/{agent_name}')
async def delete_agent(
    agent_name: str,
    orchestrator=Depends(get_orchestrator),
    config_manager=Depends(get_config_manager),
):
    """删除智能体。"""
    try:
        if not agent_name:
            raise HTTPException(status_code=400, detail='智能体名称不能为空')

        reserved_entry_agent = None
        if hasattr(orchestrator, 'get_fallback_entry_agent_name'):
            reserved_entry_agent = orchestrator.get_fallback_entry_agent_name()
        if agent_name and reserved_entry_agent and agent_name == reserved_entry_agent:
            raise HTTPException(status_code=403, detail='系统核心智能体禁止删除')

        if not config_manager.get_config(agent_name):
            raise HTTPException(status_code=404, detail=f'智能体 {agent_name} 不存在')

        config_manager.delete_config(agent_name, save=True)

        # 从 orchestrator 中移除
        if hasattr(orchestrator, 'agents') and agent_name in orchestrator.agents:
            del orchestrator.agents[agent_name]
            logger.info('已从 Orchestrator 移除智能体: %s', agent_name)

        return ok(message=f'智能体 {agent_name} 已删除')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('删除智能体失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/agents/reload')
async def reload_agents():
    """重新加载所有智能体。"""
    try:
        from dependencies import get_agent_runtime_service
        svc = get_agent_runtime_service()
        await asyncio.to_thread(svc.reload_agents)
        return ok(message='智能体已重新加载')
    except Exception as e:
        logger.error('重新加载智能体失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

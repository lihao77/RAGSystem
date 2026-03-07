# -*- coding: utf-8 -*-
"""
Agent 管理相关路由。
"""

from .shared import (
    agent_bp,
    error_response,
    get_config_manager,
    get_config,
    get_default_adapter,
    logger,
    request,
    success_response,
    _get_orchestrator,
)

@agent_bp.route('/agents', methods=['GET'])
def list_agents():
    """
    列出所有可用智能体

    Returns:
        {
            "success": true,
            "data": [
                {
                    "name": "qa_agent",
                    "description": "知识图谱问答智能体",
                    "capabilities": [...],
                    "tools": [...]
                }
            ]
        }
    """
    try:
        orchestrator = _get_orchestrator()
        agents = orchestrator.list_agents()

        return success_response(
            data=agents,
            message=f'共有 {len(agents)} 个智能体'
        )

    except Exception as e:
        logger.error(f'获取智能体列表失败: {e}')
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/agents/create', methods=['POST'])
def create_agent():
    """
    创建新智能体

    Request:
        {
            "agent_name": "new_agent",
            "display_name": "新智能体",
            "description": "描述",
            "custom_params": {
                "type": "react",
                "behavior": {
                    system_prompt: "你是一XXX的智能体..."
                    max_rounds: 10
                    auto_execute_tools: true
                }
            },
            "llm": {
                "temperature": 0.7
            }
        }
    """
    try:
        data = request.get_json()
        agent_name = data.get('agent_name')

        if not agent_name:
            return error_response(message='智能体名称不能为空', status_code=400)

        config_manager = get_config_manager()

        # 检查是否已存在
        if config_manager.get_config(agent_name):
            return error_response(message=f'智能体 {agent_name} 已存在', status_code=400)

        from agents.config import AgentConfig

        # 创建配置对象
        try:
            config = AgentConfig(**data)
        except Exception as e:
            return error_response(message=f'配置验证失败: {e}', status_code=400)

        # 保存配置
        config_manager.set_config(config, save=True)

        # 重新加载 orchestrator 中的智能体
        orchestrator = _get_orchestrator()

        # 动态加载新智能体
        try:
            from agents.config import AgentLoader
            from config import get_config as get_system_config

            loader = AgentLoader(
                model_adapter=get_default_adapter(),
                system_config=get_system_config(),
                orchestrator=orchestrator
            )

            new_agent = loader.load_agent(agent_name)
            if new_agent:
                orchestrator.register_agent(new_agent)
                logger.info(f"新智能体 {agent_name} 已创建并加载")
            else:
                logger.warning(f"智能体 {agent_name} 配置已保存但在加载时失败")

        except Exception as e:
            logger.error(f"热加载新智能体失败: {e}")
            # 不影响配置保存成功的结果

        return success_response(
            data=config.model_dump(),
            message=f'智能体 {agent_name} 创建成功'
        )

    except Exception as e:
        logger.error(f'创建智能体失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/agents/delete/<agent_name>', methods=['DELETE'])
def delete_agent(agent_name):
    """
    删除智能体
    """
    try:
        if not agent_name:
            return error_response(message='智能体名称不能为空', status_code=400)

        # 禁止删除系统智能体
        if agent_name == 'master_agent_v2':
            return error_response(message='系统核心智能体禁止删除', status_code=403)

        config_manager = get_config_manager()

        # 检查是否存在
        if not config_manager.get_config(agent_name):
            return error_response(message=f'智能体 {agent_name} 不存在', status_code=404)

        # 删除配置
        config_manager.delete_config(agent_name, save=True)

        # 重新加载 orchestrator
        orchestrator = _get_orchestrator()

        # 尝试从 orchestrator 中移除（如果支持）
        if hasattr(orchestrator, 'agents') and agent_name in orchestrator.agents:
            del orchestrator.agents[agent_name]
            logger.info(f"已从 Orchestrator 移除智能体: {agent_name}")

        return success_response(message=f'智能体 {agent_name} 已删除')

    except Exception as e:
        logger.error(f'删除智能体失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

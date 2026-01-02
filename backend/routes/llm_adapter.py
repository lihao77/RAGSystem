"""
LLM Adapter API Routes

提供 LLM Adapter 配置管理的 REST API 接口
"""

from flask import Blueprint, request, jsonify
from typing import Dict, List, Optional, Any
import logging
import sys
import os

# 添加项目根目录到 Python 路径
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

from llm_adapter import LLMAdapter, get_default_adapter
from llm_adapter.providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider

logger = logging.getLogger(__name__)

# 创建蓝图
llm_adapter_bp = Blueprint('llm_adapter', __name__)

# 获取或创建 LLM Adapter 实例
adapter = get_default_adapter()


@llm_adapter_bp.route('/providers', methods=['GET'])
def get_providers():
    """
    获取所有 Provider 列表

    Returns:
        JSON: Provider 列表
    """
    try:
        configs = adapter.get_provider_configs()
        active_providers = adapter.active_providers  # 改为列表

        providers = []
        for config in configs:
            name = config['name'].lower().replace(' ', '_')

            provider = {
                **config,
                'is_active': name in active_providers  # 检查是否在列表中
            }
            providers.append(provider)

        return jsonify({
            'success': True,
            'providers': providers,
            'active_providers': active_providers,  # 返回列表
            'load_balancer': adapter.load_balancer,
            'message': 'Provider 列表获取成功'
        })
    except Exception as e:
        logger.error(f"获取 Provider 列表失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'获取 Provider 列表失败: {str(e)}'
        }), 500


@llm_adapter_bp.route('/providers', methods=['POST'])
def create_provider():
    """
    创建新的 Provider

    Request Body:
        - provider_type: Provider 类型（openai, deepseek, openrouter）
        - name: Provider 名称
        - api_key: API 密钥
        - api_endpoint: API 端点（可选）
        - model: 模型名称
        - 其他可选参数...

    Returns:
        JSON: 创建结果
    """
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'message': '请求数据不能为空'
            }), 400

        # 必需字段
        required_fields = ['provider_type', 'name', 'api_key', 'model']
        for field in required_fields:
            if not data.get(field):
                return jsonify({
                    'success': False,
                    'message': f'缺少必需字段: {field}'
                }), 400

        # 注册 Provider
        config_id = adapter.register_provider_from_config(data)

        return jsonify({
            'success': True,
            'message': 'Provider 创建成功',
            'config_id': config_id
        })
    except Exception as e:
        logger.error(f"创建 Provider 失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'创建 Provider 失败: {str(e)}'
        }), 500


@llm_adapter_bp.route('/providers/<provider_name>', methods=['PUT'])
def update_provider(provider_name):
    """
    更新 Provider

    Args:
        provider_name: Provider 名称

    Request Body:
        同创建接口

    Returns:
        JSON: 更新结果
    """
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'message': '请求数据不能为空'
            }), 400

        # 由于 Provider 的属性大部分是初始化时设置的，这里采用删除后重建的方式
        # 但保留配置ID
        config_id = None
        if provider_name in adapter.config_ids:
            config_id = adapter.config_ids[provider_name]

        if provider_name in adapter.providers:
            adapter.remove_provider(provider_name, delete_config=False)

        new_config_id = adapter.register_provider_from_config(data, config_id=config_id)

        return jsonify({
            'success': True,
            'message': 'Provider 更新成功',
            'config_id': new_config_id
        })
    except Exception as e:
        logger.error(f"更新 Provider 失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'更新 Provider 失败: {str(e)}'
        }), 500


@llm_adapter_bp.route('/providers/<provider_name>', methods=['DELETE'])
def delete_provider(provider_name):
    """
    删除 Provider

    Args:
        provider_name: Provider 名称

    Returns:
        JSON: 删除结果
    """
    try:
        adapter.remove_provider(provider_name)

        return jsonify({
            'success': True,
            'message': 'Provider 删除成功'
        })
    except Exception as e:
        logger.error(f"删除 Provider 失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'删除 Provider 失败: {str(e)}'
        }), 500


@llm_adapter_bp.route('/active-providers', methods=['POST'])
def set_active_providers():
    """
    设置活动的 Provider 列表

    Request Body:
        - providers: Provider 名称列表

    Returns:
        JSON: 设置结果
    """
    try:
        data = request.get_json()
        provider_names = data.get('providers', [])

        if not isinstance(provider_names, list):
            return jsonify({
                'success': False,
                'message': 'providers 必须是列表'
            }), 400

        adapter.set_active_providers(provider_names)

        return jsonify({
            'success': True,
            'message': '活动 Provider 设置成功',
            'active_providers': adapter.active_providers
        })
    except Exception as e:
        logger.error(f"设置活动 Provider 失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'设置活动 Provider 失败: {str(e)}'
        }), 500


@llm_adapter_bp.route('/load-balancer', methods=['POST'])
def set_load_balancer():
    """
    设置负载均衡策略

    Request Body:
        - strategy: 策略名称（round_robin, random, health）

    Returns:
        JSON: 设置结果
    """
    try:
        data = request.get_json()
        strategy = data.get('strategy')

        if not strategy:
            return jsonify({
                'success': False,
                'message': '请提供策略名称'
            }), 400

        adapter.set_load_balancer(strategy)

        return jsonify({
            'success': True,
            'message': '负载均衡策略设置成功'
        })
    except Exception as e:
        logger.error(f"设置负载均衡策略失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'设置负载均衡策略失败: {str(e)}'
        }), 500


@llm_adapter_bp.route('/test', methods=['POST'])
def test_provider():
    """
    测试 Provider

    Request Body:
        - provider: Provider 名称（可选）
        - prompt: 测试提示词

    Returns:
        JSON: 测试结果
    """
    try:
        data = request.get_json()
        provider_name = data.get('provider')
        prompt = data.get('prompt')

        if not prompt:
            return jsonify({
                'success': False,
                'message': '请提供测试提示词'
            }), 400

        # 测试使用简单的消息列表
        messages = [{"role": "user", "content": prompt}]

        response = adapter.chat_completion(
            messages=messages,
            provider=provider_name,
            temperature=0.7,
            max_tokens=500
        )

        return jsonify({
            'success': True,
            'message': '测试成功',
            'response': {
                'content': response.content,
                'error': response.error,
                'model': response.model,
                'provider': response.provider,
                'cost': response.cost,
                'latency': response.latency,
                'usage': response.usage,
                'finish_reason': response.finish_reason
            }
        })
    except Exception as e:
        logger.error(f"测试 Provider 失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'测试 Provider 失败: {str(e)}'
        }), 500

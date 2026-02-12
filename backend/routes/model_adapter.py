"""
Model Adapter API Routes

提供 Model Adapter 配置管理的 REST API 接口
"""

from flask import Blueprint, request, jsonify
from typing import Dict, List, Optional, Any
import logging
import sys
import os

# 添加项目根目录到 Python 路径
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

from model_adapter import ModelAdapter, get_default_adapter
from model_adapter.providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider

logger = logging.getLogger(__name__)

# 创建蓝图
model_adapter_bp = Blueprint('model_adapter', __name__)

# 获取或创建 Model Adapter 实例
adapter = get_default_adapter()


@model_adapter_bp.route('/providers', methods=['GET'])
def get_providers():
    """
    获取所有 Provider 列表

    Returns:
        JSON: Provider 列表
    """
    try:
        configs = adapter.get_provider_configs()

        providers = []
        for config in configs:
            provider = {
                **config
            }
            providers.append(provider)

        return jsonify({
            'success': True,
            'providers': providers,
            'message': 'Provider 列表获取成功'
        })
    except Exception as e:
        logger.error(f"获取 Provider 列表失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'获取 Provider 列表失败: {str(e)}'
        }), 500


@model_adapter_bp.route('/providers', methods=['POST'])
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

        # 必需字段（model 现在是可选的，因为可以使用 models 列表）
        required_fields = ['provider_type', 'name', 'api_key']
        for field in required_fields:
            if not data.get(field):
                return jsonify({
                    'success': False,
                    'message': f'缺少必需字段: {field}'
                }), 400

        # 自动同步逻辑：将 model_map 中的所有模型添加到 models 列表
        config = data.copy()
        # 即使前端没有传 models，我们也从 model_map 生成默认列表
        if 'model_map' in config and config['model_map']:
            current_models = set(config.get('models', []))
            for task, model in config['model_map'].items():
                if model and model.strip():
                    current_models.add(model.strip())
            # config['models'] = list(current_models) # 移除对 models 字段的强制填充
            # 仅保留 model_map 作为核心配置，models 字段仅作向后兼容保留，不再主动维护

        # 注册 Provider
        config_id = adapter.register_provider_from_config(config)

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


@model_adapter_bp.route('/providers/<provider_name>', methods=['PUT'])
def update_provider(provider_name):
    """
    更新 Provider

    Args:
        provider_name: Provider 名称

    Request Body:
        - models: 支持模型列表（可选）
        - temperature: 温度（可选）
        - max_tokens: 最大Token（可选）
        - timeout: 超时时间（可选）
        - retry_attempts: 重试次数（可选）
        - supports_function_calling: 支持工具调用（可选）

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

        # 获取旧的配置
        config_id = adapter.config_ids.get(provider_name)
        if not config_id:
            return jsonify({
                'success': False,
                'message': f'Provider 不存在: {provider_name}'
            }), 404

        # 加载现有配置
        config_data = adapter.config_store.load_config(config_id)
        if not config_data or 'config' not in config_data:
            return jsonify({
                'success': False,
                'message': f'无法加载 Provider 配置: {provider_name}'
            }), 500

        # 合并配置（保留原有值，用新值覆盖）
        config = config_data['config'].copy()

        # 只更新允许修改的字段
        allowed_fields = [
            'models', 'temperature', 'max_tokens', 'timeout',
            'retry_attempts', 'supports_function_calling', 'model_map'
        ]

        for field in allowed_fields:
            if field in data:
                config[field] = data[field]
        
        # 自动同步逻辑：将 model_map 中的所有模型添加到 models 列表
        # 如果前端没有传 models，则完全依赖 model_map
        if 'model_map' in config and config['model_map']:
            current_models = set(config.get('models', []))
            for task, model in config['model_map'].items():
                if model and model.strip():
                    current_models.add(model.strip())
            # config['models'] = list(current_models) # 移除对 models 字段的强制填充
            # 仅保留 model_map 作为核心配置，models 字段仅作向后兼容保留，不再主动维护
        
        # 即使 models 为空，也是合法的（表示未配置支持模型列表）

        # 确保 config 包含所有必需字段
        if 'provider_type' not in config:
            config['provider_type'] = config_data['config'].get('provider_type', '')
        if 'name' not in config:
            config['name'] = config_data['config'].get('name', '')
        if 'api_key' not in config:
            config['api_key'] = config_data['config'].get('api_key', '')
        if 'api_endpoint' not in config:
            config['api_endpoint'] = config_data['config'].get('api_endpoint', '')

        # 删除旧的 provider
        if provider_name in adapter.providers:
            adapter.remove_provider(provider_name, delete_config=False)

        # 重新注册（使用更新后的配置）
        new_config_id = adapter.register_provider_from_config(config, config_id=config_id)

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


@model_adapter_bp.route('/providers/<provider_name>', methods=['DELETE'])
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




@model_adapter_bp.route('/test', methods=['POST'])
def test_provider():
    """
    测试 Provider

    Request Body:
        - provider: Provider 名称（必需）
        - prompt: 测试提示词（必需）
        - model: 模型名称（可选）
        - task: 任务类型 (chat/embedding)

    Returns:
        JSON: 测试结果
    """
    try:
        data = request.get_json()
        provider_name = data.get('provider')
        prompt = data.get('prompt')
        model = data.get('model')  # 可选的模型参数
        task = data.get('task', 'chat') # 任务类型

        if not provider_name:
            return jsonify({
                'success': False,
                'message': '请提供 Provider 名称'
            }), 400

        if not prompt:
            return jsonify({
                'success': False,
                'message': '请提供测试内容'
            }), 400

        if task == 'chat':
            # 测试对话
            messages = [{"role": "user", "content": prompt}]
            response = adapter.chat_completion(
                messages=messages,
                provider=provider_name,
                model=model,  # 传入模型参数
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
            
        elif task == 'embedding':
            # 测试 Embedding
            response = adapter.embed(
                texts=[prompt],
                provider=provider_name,
                model=model
            )
            
            return jsonify({
                'success': True,
                'message': '测试成功',
                'response': {
                    'embeddings': response.embeddings,
                    'error': response.error,
                    'model': response.model,
                    'provider': response.provider,
                    'latency': response.latency,
                    'usage': response.usage
                }
            })
            
        else:
             return jsonify({
                'success': False,
                'message': f'不支持的任务类型: {task}'
            }), 400
            
    except Exception as e:
        logger.error(f"测试 Provider 失败: {str(e)}")
        return jsonify({
            'success': False,
            'message': f'测试 Provider 失败: {str(e)}'
        }), 500

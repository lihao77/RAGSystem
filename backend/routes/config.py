# -*- coding: utf-8 -*-
"""
配置管理路由 - 提供配置读取、更新、验证和测试功能
"""

from flask import Blueprint, request, jsonify
import logging
import json
import yaml
from pathlib import Path
from config import get_config, reload_config, AppConfig
from config.base import ConfigManager
from db import test_connection
import requests

logger = logging.getLogger(__name__)

config_bp = Blueprint('config', __name__)


@config_bp.route('/', methods=['GET'])
def get_current_config():
    """获取当前配置"""
    try:
        config = get_config()

        # 将配置转换为字典，并隐藏敏感信息
        config_dict = {
            'neo4j': {
                'uri': config.neo4j.uri,
                'user': config.neo4j.user,
                'password': '***' if config.neo4j.password else ''
            },
            'llm': {
                'api_endpoint': config.llm.api_endpoint,
                'api_key': '***' if config.llm.api_key else '',
                'model_name': config.llm.model_name,
                'temperature': config.llm.temperature,
                'max_tokens': config.llm.max_tokens
            },
            'system': {
                'max_content_length': config.system.max_content_length
            },
            'external_libs': {
                'llmjson': config.external_libs.llmjson,
                'json2graph': config.external_libs.json2graph
            }
        }

        return jsonify({
            'success': True,
            'data': config_dict
        })
    except Exception as e:
        logger.error(f'获取配置失败: {e}')
        return jsonify({
            'success': False,
            'message': f'获取配置失败: {str(e)}'
        }), 500


@config_bp.route('/raw', methods=['GET'])
def get_raw_config():
    """获取原始配置（不隐藏敏感信息，需要认证）"""
    try:
        # 注意：生产环境应该添加认证检查
        config_manager = ConfigManager()
        config_file_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.yaml'

        if config_file_path.exists():
            with open(config_file_path, 'r', encoding='utf-8') as f:
                config_content = f.read()

            # 解析 YAML 为字典
            config_dict = yaml.safe_load(config_content) or {}

            return jsonify({
                'success': True,
                'data': config_dict,
                'content': config_content
            })
        else:
            # 如果用户配置文件不存在，返回默认配置
            default_config_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.default.yaml'
            with open(default_config_path, 'r', encoding='utf-8') as f:
                default_content = f.read()

            return jsonify({
                'success': True,
                'data': yaml.safe_load(default_content) or {},
                'content': default_content
            })

    except Exception as e:
        logger.error(f'获取原始配置失败: {e}')
        return jsonify({
            'success': False,
            'message': f'获取原始配置失败: {str(e)}'
        }), 500


@config_bp.route('/', methods=['PUT', 'POST'])
def update_config():
    """更新配置"""
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'message': '请求数据不能为空'
            }), 400

        config_file_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.yaml'

        # 确保配置目录存在
        config_file_path.parent.mkdir(parents=True, exist_ok=True)

        # 写入配置文件
        with open(config_file_path, 'w', encoding='utf-8') as f:
            yaml.dump(data, f, allow_unicode=True, default_flow_style=False, indent=2)

        logger.info('配置文件已更新')

        return jsonify({
            'success': True,
            'message': '配置更新成功'
        })

    except Exception as e:
        logger.error(f'更新配置失败: {e}')
        return jsonify({
            'success': False,
            'message': f'配置更新失败: {str(e)}'
        }), 500


@config_bp.route('/validate', methods=['POST'])
def validate_config():
    """验证配置格式"""
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'message': '请求数据不能为空'
            }), 400

        # 尝试创建 AppConfig 实例进行验证
        config = AppConfig(**data)

        return jsonify({
            'success': True,
            'message': '配置格式验证通过',
            'data': {
                'neo4j_valid': bool(config.neo4j.uri and config.neo4j.user),
                'llm_valid': bool(config.llm.api_endpoint and config.llm.model_name),
                'has_neo4j_password': bool(config.neo4j.password),
                'has_llm_api_key': bool(config.llm.api_key)
            }
        })

    except Exception as e:
        logger.error(f'配置验证失败: {e}')
        return jsonify({
            'success': False,
            'message': f'配置验证失败: {str(e)}'
        }), 400


@config_bp.route('/test/neo4j', methods=['POST'])
def test_neo4j_connection():
    """测试Neo4j连接"""
    try:
        data = request.get_json() or {}

        # 如果提供了配置，使用提供的配置；否则使用当前配置
        if data.get('neo4j'):
            neo4j_config = data['neo4j']
            uri = neo4j_config.get('uri')
            user = neo4j_config.get('user')
            password = neo4j_config.get('password')
        else:
            config = get_config()
            uri = config.neo4j.uri
            user = config.neo4j.user
            password = config.neo4j.password
            
        if not all([uri, user, password]):
            return jsonify({
                'success': False,
                'message': 'Neo4j 配置不完整'
            }), 400

        # 测试连接
        from neo4j import GraphDatabase

        driver = GraphDatabase.driver(uri, auth=(user, password))
        with driver.session() as session:
            result = session.run('RETURN 1 as n')
            record = result.single()

        driver.close()

        if record:
            return jsonify({
                'success': True,
                'message': f'Neo4j 连接成功: {uri}'
            })
        else:
            return jsonify({
                'success': False,
                'message': '连接测试失败: 无返回结果'
            }), 500

    except Exception as e:
        logger.error(f'Neo4j 连接测试失败: {e}')
        error_msg = str(e).lower()

        # 根据错误类型返回友好的错误消息
        if 'authentication failure' in error_msg or 'unauthorized' in error_msg:
            friendly_msg = '认证失败：请检查用户名和密码是否正确'
        elif 'connection refused' in error_msg or 'unable to connect' in error_msg:
            friendly_msg = '连接被拒绝：请检查 Neo4j 服务是否正在运行'
        elif 'timeout' in error_msg:
            friendly_msg = '连接超时：请检查网络连接或 Neo4j 服务地址'
        elif 'service unavailable' in error_msg:
            friendly_msg = '服务不可用：Neo4j 服务可能已停止或未响应'
        else:
            friendly_msg = f'连接失败：{error_msg}'

        return jsonify({
            'success': False,
            'message': friendly_msg
        }), 500


@config_bp.route('/test/llm', methods=['POST'])
def test_llm_connection():
    """测试LLM API连接"""
    try:
        data = request.get_json() or {}

        # 如果提供了配置，使用提供的配置；否则使用当前配置
        if data.get('llm'):
            llm_config = data['llm']
            api_endpoint = llm_config.get('api_endpoint')
            api_key = llm_config.get('api_key')
            model_name = llm_config.get('model_name')
        else:
            config = get_config()
            api_endpoint = config.llm.api_endpoint
            api_key = config.llm.api_key
            model_name = config.llm.model_name

        if not all([api_endpoint, api_key, model_name]):
            return jsonify({
                'success': False,
                'message': 'LLM 配置不完整'
            }), 400

        # 测试API调用
        test_message = "Say 'Hello from LLM test'"

        response = requests.post(
            f"{api_endpoint}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": model_name,
                "messages": [
                    {"role": "user", "content": test_message}
                ],
                "max_tokens": 50
            },
            timeout=30
        )
        

        if response.status_code == 200:
            result = response.json()
            reply = result['choices'][0]['message']['content']

            return jsonify({
                'success': True,
                'message': 'LLM API 连接成功',
                'data': {
                    'reply': reply[:100] + '...' if len(reply) > 100 else reply,
                    'model': model_name
                }
            })
        else:
            error_msg = f'HTTP {response.status_code}'
            if response.status_code == 401:
                friendly_msg = '认证失败：请检查 API 密钥是否正确'
            elif response.status_code == 404:
                friendly_msg = 'API 端点不存在：请检查 API 地址或模型名称'
            elif response.status_code == 429:
                friendly_msg = '请求频率过高：请稍后重试或检查 API 额度'
            elif response.status_code == 500:
                friendly_msg = '服务器内部错误：请稍后重试或联系服务提供商'
            else:
                friendly_msg = f'API 调用失败（{error_msg}）：请检查配置信息'

            return jsonify({
                'success': False,
                'message': friendly_msg
            }), 400

    except requests.exceptions.Timeout:
        return jsonify({
            'success': False,
            'message': '连接超时，请检查网络或API端点'
        }), 500
    except Exception as e:
        logger.error(f'LLM 连接测试失败: {e}')
        error_msg = str(e).lower()

        # 根据错误类型返回友好的错误消息
        if 'authentication' in error_msg or 'unauthorized' in error_msg or 'invalid api key' in error_msg:
            friendly_msg = '认证失败：请检查 API 密钥是否正确'
        elif 'connection' in error_msg and ('error' in error_msg or 'refused' in error_msg):
            friendly_msg = '连接失败：请检查网络连接或 API 端点地址'
        elif 'timeout' in error_msg:
            friendly_msg = '请求超时：请检查网络连接或稍后重试'
        elif 'name resolution' in error_msg or 'resolve' in error_msg:
            friendly_msg = '无法解析 API 地址：请检查 API 端点是否正确'
        elif 'ssl' in error_msg or 'certificate' in error_msg:
            friendly_msg = 'SSL 证书错误：请检查 API 端点是否正确或使用 HTTP'
        elif 'model' in error_msg and ('not found' in error_msg or 'does not exist' in error_msg):
            friendly_msg = '模型不存在：请检查模型名称是否正确'
        else:
            friendly_msg = '连接失败：请检查配置信息和网络连接'

        return jsonify({
            'success': False,
            'message': friendly_msg
        }), 500


@config_bp.route('/reload', methods=['POST'])
def reload_config_api():
    """热重载配置"""
    try:
        config = reload_config()

        return jsonify({
            'success': True,
            'message': '配置已重新加载',
            'data': {
                'neo4j_uri': config.neo4j.uri,
                'llm_model': config.llm.model_name
            }
        })

    except Exception as e:
        logger.error(f'配置热重载失败: {e}')
        return jsonify({
            'success': False,
            'message': f'配置热重载失败: {str(e)}'
        }), 500


@config_bp.route('/export', methods=['GET'])
def export_config():
    """导出配置"""
    try:
        config_manager = ConfigManager()
        config_file_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.yaml'

        if config_file_path.exists():
            with open(config_file_path, 'r', encoding='utf-8') as f:
                config_content = f.read()

            return jsonify({
                'success': True,
                'data': config_content,
                'filename': 'config.yaml'
            })
        else:
            return jsonify({
                'success': False,
                'message': '配置文件不存在'
            }), 404

    except Exception as e:
        logger.error(f'导出配置失败: {e}')
        return jsonify({
            'success': False,
            'message': f'导出配置失败: {str(e)}'
        }), 500


@config_bp.route('/schema', methods=['GET'])
def get_config_schema():
    """获取配置模式（用于前端表单生成）"""
    try:
        schema = {
            "title": "RAGSystem 配置",
            "type": "object",
            "properties": {
                "neo4j": {
                    "title": "Neo4j 数据库",
                    "type": "object",
                    "properties": {
                        "uri": {
                            "title": "连接地址",
                            "type": "string",
                            "default": "bolt://localhost:7687",
                            "description": "Neo4j 数据库连接地址"
                        },
                        "user": {
                            "title": "用户名",
                            "type": "string",
                            "default": "neo4j",
                            "description": "Neo4j 数据库用户名"
                        },
                        "password": {
                            "title": "密码",
                            "type": "string",
                            "description": "Neo4j 数据库密码",
                            "format": "password"
                        }
                    },
                    "required": ["uri", "user"]
                },
                "llm": {
                    "title": "LLM API",
                    "type": "object",
                    "properties": {
                        "api_endpoint": {
                            "title": "API 端点",
                            "type": "string",
                            "default": "https://api.deepseek.com/v1",
                            "description": "LLM API 服务地址"
                        },
                        "api_key": {
                            "title": "API 密钥",
                            "type": "string",
                            "description": "LLM API 密钥",
                            "format": "password"
                        },
                        "model_name": {
                            "title": "模型名称",
                            "type": "string",
                            "default": "deepseek-chat",
                            "description": "使用的模型名称"
                        },
                        "temperature": {
                            "title": "生成温度",
                            "type": "number",
                            "default": 0.7,
                            "minimum": 0,
                            "maximum": 2,
                            "description": "控制生成结果的随机性，值越大越随机"
                        },
                        "max_tokens": {
                            "title": "最大令牌数",
                            "type": "integer",
                            "default": 4096,
                            "minimum": 100,
                            "maximum": 32000,
                            "description": "生成结果的最大令牌数"
                        }
                    },
                    "required": ["api_endpoint", "model_name"]
                },
                "system": {
                    "title": "系统设置",
                    "type": "object",
                    "properties": {}
                }
            }
        }

        return jsonify({
            'success': True,
            'data': schema
        })

    except Exception as e:
        logger.error(f'获取配置模式失败: {e}')
        return jsonify({
            'success': False,
            'message': f'获取配置模式失败: {str(e)}'
        }), 500

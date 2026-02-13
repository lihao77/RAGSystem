# -*- coding: utf-8 -*-
"""
配置服务 - 配置管理业务逻辑
"""

import logging
import yaml
import requests
from pathlib import Path
from config import get_config, reload_config as reload_config_func, AppConfig
from db import test_connection

logger = logging.getLogger(__name__)


class ConfigService:
    """配置服务类"""
    
    def get_raw_config(self):
        """
        获取原始配置文件内容（YAML 格式）
        完全遵循原始逻辑
        
        Returns:
            dict: {'data': dict, 'content': str}
        """
        try:
            import yaml
            
            config_file_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.yaml'
            
            if config_file_path.exists():
                with open(config_file_path, 'r', encoding='utf-8') as f:
                    config_content = f.read()
                
                # 解析 YAML 为字典
                config_dict = yaml.safe_load(config_content) or {}
                
                return {
                    'data': config_dict,
                    'content': config_content
                }
            else:
                # 如果用户配置文件不存在，返回默认配置
                default_config_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.default.yaml'
                with open(default_config_path, 'r', encoding='utf-8') as f:
                    default_content = f.read()
                
                return {
                    'data': yaml.safe_load(default_content) or {},
                    'content': default_content
                }
                
        except Exception as e:
            logger.error(f'获取原始配置失败: {e}')
            raise
    
    def get_config_dict(self, hide_sensitive=True):
        """
        获取当前配置（字典格式）
        
        Args:
            hide_sensitive: 是否隐藏敏感信息
            
        Returns:
            dict: 配置字典
        """
        try:
            config = get_config()
            
            # 将配置转换为字典
            config_dict = {
                'neo4j': {
                    'uri': config.neo4j.uri,
                    'user': config.neo4j.user,
                    'password': '***' if hide_sensitive and config.neo4j.password else config.neo4j.password
                },
                'llm': {
                    'api_endpoint': config.llm.api_endpoint,
                    'api_key': '***' if hide_sensitive and config.llm.api_key else config.llm.api_key,
                    'model_name': config.llm.model_name,
                    'temperature': config.llm.temperature,
                    'max_tokens': config.llm.max_tokens
                },
                'embedding': {
                    'provider': config.embedding.provider,
                    'model_name': config.embedding.model_name,
                    'batch_size': config.embedding.batch_size
                },
                'system': {
                    'max_content_length': config.system.max_content_length
                },
                'external_libs': {
                    'llmjson': config.external_libs.llmjson,
                    'json2graph': config.external_libs.json2graph
                }
            }
            
            return config_dict
            
        except Exception as e:
            logger.error(f'获取配置失败: {e}')
            raise
    
    def update_config(self, config_data: dict, merge: bool = True):
        """
        更新配置文件，并重新加载配置
        
        Args:
            config_data: 配置数据字典
            merge: 是否与原配置合并（默认True），False则完全覆盖
            
        Returns:
            bool: 是否更新成功
        """
        try:
            config_file_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.yaml'
            config_file_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 读取现有配置（如果存在且需要合并）
            if merge and config_file_path.exists():
                with open(config_file_path, 'r', encoding='utf-8') as f:
                    existing_config = yaml.safe_load(f) or {}
                # 深度合并
                merged_config = self._deep_merge(existing_config, config_data)
            else:
                merged_config = config_data
            
            # 写入
            with open(config_file_path, 'w', encoding='utf-8') as f:
                yaml.dump(merged_config, f, allow_unicode=True, 
                         default_flow_style=False, indent=2, sort_keys=False)
            
            logger.info('配置文件已更新')
            reload_config_func()
            logger.info('配置已重新加载')
            return True
            
        except Exception as e:
            logger.error(f'更新配置失败: {e}')
            raise
        
    def _deep_merge(self, base: dict, update: dict) -> dict:
        """递归合并字典"""
        result = base.copy()
        for key, value in update.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._deep_merge(result[key], value)
            else:
                result[key] = value
        return result
    
    def validate_config(self, config_data):
        """
        验证配置格式
        
        Args:
            config_data: 配置数据字典
            
        Returns:
            dict: 验证结果
                {
                    'valid': bool,
                    'neo4j_valid': bool,
                    'llm_valid': bool,
                    'has_neo4j_password': bool,
                    'has_llm_api_key': bool
                }
        """
        try:
            # 尝试创建 AppConfig 实例进行验证
            config = AppConfig(**config_data)
            
            return {
                'valid': True,
                'neo4j_valid': bool(config.neo4j.uri and config.neo4j.user),
                'llm_valid': bool(config.llm.api_endpoint and config.llm.model_name),
                'has_neo4j_password': bool(config.neo4j.password),
                'has_llm_api_key': bool(config.llm.api_key)
            }
            
        except Exception as e:
            logger.error(f'配置验证失败: {e}')
            raise
    
    def test_neo4j_connection(self, neo4j_config=None):
        """
        测试Neo4j连接
        
        Args:
            neo4j_config: Neo4j配置字典（可选），如果为None则使用当前配置
            
        Returns:
            dict: 测试结果 {'success': bool, 'message': str}
        """
        try:
            # 如果提供了配置，使用提供的配置；否则使用当前配置
            if neo4j_config:
                uri = neo4j_config.get('uri')
                user = neo4j_config.get('user')
                password = neo4j_config.get('password')
            else:
                config = get_config()
                uri = config.neo4j.uri
                user = config.neo4j.user
                password = config.neo4j.password
            
            if not all([uri, user, password]):
                return {
                    'success': False,
                    'message': 'Neo4j 配置不完整'
                }
            
            # 测试连接
            from neo4j import GraphDatabase
            
            driver = GraphDatabase.driver(uri, auth=(user, password))
            with driver.session() as session:
                result = session.run('RETURN 1 as n')
                record = result.single()
            
            driver.close()
            
            if record:
                return {
                    'success': True,
                    'message': f'Neo4j 连接成功: {uri}'
                }
            else:
                return {
                    'success': False,
                    'message': '连接测试失败: 无返回结果'
                }
                
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
            
            return {
                'success': False,
                'message': friendly_msg
            }
    
    def test_llm_connection(self, llm_config=None):
        """
        测试LLM API连接
        
        Args:
            llm_config: LLM配置字典（可选），如果为None则使用当前配置
            
        Returns:
            dict: 测试结果 {'success': bool, 'message': str, 'data': {...}}
        """
        try:
            # 如果提供了配置，使用提供的配置；否则使用当前配置
            if llm_config:
                api_endpoint = llm_config.get('api_endpoint')
                api_key = llm_config.get('api_key')
                model_name = llm_config.get('model_name')
            else:
                config = get_config()
                api_endpoint = config.llm.api_endpoint
                api_key = config.llm.api_key
                model_name = config.llm.model_name
            
            if not all([api_endpoint, api_key, model_name]):
                return {
                    'success': False,
                    'message': 'LLM 配置不完整'
                }
            
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
                
                return {
                    'success': True,
                    'message': 'LLM API 连接成功',
                    'data': {
                        'reply': reply[:100] + '...' if len(reply) > 100 else reply,
                        'model': model_name
                    }
                }
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
                
                return {
                    'success': False,
                    'message': friendly_msg
                }
                
        except requests.exceptions.Timeout:
            return {
                'success': False,
                'message': '连接超时，请检查网络或API端点'
            }
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
            
            return {
                'success': False,
                'message': friendly_msg
            }
    
    def reload_config(self):
        """
        热重载配置
        完全遵循原始逻辑：只返回部分关键配置信息
        
        Returns:
            dict: 重载后的部分配置 {'neo4j_uri': str, 'llm_model': str}
        """
        try:
            config = reload_config_func()
            logger.info('配置已重新加载')
            
            return {
                'neo4j_uri': config.neo4j.uri,
                'llm_model': config.llm.model_name
            }
            
        except Exception as e:
            logger.error(f'重载配置失败: {e}')
            raise
    
    def export_config(self):
        """
        导出配置文件内容
        完全遵循原始逻辑
        
        Returns:
            tuple: (content, filename) 或 None（文件不存在时）
        """
        try:
            config_file_path = Path(__file__).parent.parent / 'config' / 'yaml' / 'config.yaml'
            
            if not config_file_path.exists():
                return None
            
            with open(config_file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            return (content, 'config.yaml')
            
        except Exception as e:
            logger.error(f'导出配置失败: {e}')
            raise
    
    def get_config_schema(self):
        """
        获取配置模式（用于前端表单生成）
        
        Returns:
            dict: 配置模式定义
        """
        try:
            schema = {
                'neo4j': {
                    'title': 'Neo4j 数据库配置',
                    'fields': [
                        {
                            'name': 'uri',
                            'label': '数据库地址',
                            'type': 'string',
                            'required': True,
                            'default': 'bolt://localhost:7687',
                            'placeholder': '例如: bolt://localhost:7687'
                        },
                        {
                            'name': 'user',
                            'label': '用户名',
                            'type': 'string',
                            'required': True,
                            'default': 'neo4j'
                        },
                        {
                            'name': 'password',
                            'label': '密码',
                            'type': 'password',
                            'required': True
                        }
                    ]
                },
                'llm': {
                    'title': 'LLM API 配置',
                    'fields': [
                        {
                            'name': 'api_endpoint',
                            'label': 'API 端点',
                            'type': 'string',
                            'required': True,
                            'default': 'https://api.deepseek.com/v1',
                            'placeholder': '例如: https://api.deepseek.com/v1'
                        },
                        {
                            'name': 'api_key',
                            'label': 'API 密钥',
                            'type': 'password',
                            'required': True
                        },
                        {
                            'name': 'model_name',
                            'label': '模型名称',
                            'type': 'string',
                            'required': True,
                            'default': 'deepseek-chat'
                        },
                        {
                            'name': 'temperature',
                            'label': '温度参数',
                            'type': 'number',
                            'default': 0.7,
                            'min': 0,
                            'max': 2,
                            'step': 0.1
                        },
                        {
                            'name': 'max_tokens',
                            'label': '最大令牌数',
                            'type': 'number',
                            'default': 4000,
                            'min': 1,
                            'max': 32000
                        }
                    ]
                },
                'embedding': {
                    'title': '嵌入模型配置',
                    'fields': [
                        {
                            'name': 'provider',
                            'label': 'Provider',
                            'type': 'string',
                            'required': True,
                            'default': 'modelscope'
                        },
                        {
                            'name': 'model_name',
                            'label': '模型名称',
                            'type': 'string',
                            'required': True,
                            'default': 'text-embedding-3-small'
                        },
                        {
                            'name': 'batch_size',
                            'label': '批处理大小',
                            'type': 'number',
                            'default': 100
                        }
                    ]
                },
                'system': {
                    'title': '系统配置',
                    'fields': [
                        {
                            'name': 'max_content_length',
                            'label': '最大上传文件大小',
                            'type': 'number',
                            'default': 16777216,
                            'description': '单位：字节（16MB = 16777216）'
                        }
                    ]
                }
            }
            
            return schema
            
        except Exception as e:
            logger.error(f'获取配置模式失败: {e}')
            raise
    
    def get_services_status(self):
        """
        获取所有服务的状态
        完全遵循原始 routes/config.py 的逻辑
        
        Returns:
            dict: 服务状态信息，格式：
            {
                'services': [neo4j_status, vector_status, llm_status],
                'overall_status': 'ready' | 'partial'
            }
        """
        try:
            from db import is_neo4j_configured, test_connection
            from init_vector_store import is_vector_db_configured
            
            config = get_config()
            
            # Neo4j 状态
            neo4j_configured = is_neo4j_configured()
            neo4j_status = {
                'name': 'Neo4j',
                'configured': neo4j_configured,
                'status': 'not_configured' if not neo4j_configured else 'unknown',
                'message': '未配置' if not neo4j_configured else '已配置，但未测试连接'
            }
            
            if neo4j_configured:
                try:
                    if test_connection():
                        neo4j_status['status'] = 'ready'
                        neo4j_status['message'] = '已连接'
                    else:
                        neo4j_status['status'] = 'error'
                        neo4j_status['message'] = '连接失败'
                except Exception as e:
                    neo4j_status['status'] = 'error'
                    neo4j_status['message'] = f'连接错误: {str(e)}'
            
            # 向量数据库状态
            vector_configured = is_vector_db_configured()
            vector_status = {
                'name': '向量数据库',
                'configured': vector_configured,
                'status': 'not_configured' if not vector_configured else 'ready',
                'message': '未配置嵌入模型' if not vector_configured else '已配置'
            }
            
            if vector_configured:
                # 显示嵌入模式信息
                vector_status['message'] = f'Provider: {config.embedding.provider}, 模型: {config.embedding.model_name}'
            
            llm_configured = bool(config.llm.provider and config.llm.model_name)
            llm_status = {
                'name': 'LLM',
                'configured': llm_configured,
                'status': 'not_configured' if not llm_configured else 'ready',
                'message': '未配置' if not llm_configured else f'已配置: {config.llm.provider} - {config.llm.model_name}'
            }
            
            return {
                'services': [neo4j_status, vector_status, llm_status],
                'overall_status': 'ready' if all([neo4j_configured, vector_configured, llm_configured]) else 'partial'
            }
            
        except Exception as e:
            logger.error(f'获取服务状态失败: {e}')
            raise
    
    def reinit_service(self, service_name):
        """
        重新初始化指定服务
        
        Args:
            service_name: 服务名称 ('neo4j', 'vector' 或 'llm')
            
        Returns:
            dict: 初始化结果 {'success': bool, 'message': str}
        """
        try:
            # 首先重新加载配置
            reload_config_func()
            
            if service_name == 'neo4j':
                from db import neo4j_conn, is_neo4j_configured
                
                # 检查配置
                if not is_neo4j_configured():
                    return {
                        'success': False,
                        'message': 'Neo4j 未配置，请先配置连接信息'
                    }
                
                # 重新连接（单例模式，自动处理旧连接）
                driver = neo4j_conn.reconnect()
                
                # 测试连接
                if driver:
                    try:
                        with driver.session() as session:
                            session.run('RETURN 1')
                        return {
                            'success': True,
                            'message': 'Neo4j 重新连接成功'
                        }
                    except Exception as e:
                        return {
                            'success': False,
                            'message': f'Neo4j 连接测试失败: {str(e)}'
                        }
                else:
                    return {
                        'success': False,
                        'message': 'Neo4j 重新连接失败'
                    }
                    
            elif service_name == 'vector':
                from init_vector_store import init_vector_store, is_vector_db_configured
                
                if not is_vector_db_configured():
                    return {
                        'success': False,
                        'message': '向量数据库未配置，请先配置嵌入模型'
                    }
                
                # 强制重新初始化（force=True）
                success = init_vector_store(force=True)
                
                if success:
                    return {
                        'success': True,
                        'message': '向量数据库重新初始化成功'
                    }
                else:
                    return {
                        'success': False,
                        'message': '向量数据库重新初始化失败'
                    }
            elif service_name == 'llm':
                # 重新加载 LLM 配置
                try:
                    config = get_config()
                    if not config.llm.provider:
                        return {
                            'success': False,
                            'message': 'LLM 未配置，请先配置 Model Adapter'
                        }
                    
                    # 重新测试连接
                    # 使用 Model Adapter 进行测试
                    from model_adapter.adapter import get_default_adapter
                    
                    # 使用单例而不是创建新实例
                    adapter = get_default_adapter()
                    try:
                        # 尝试生成一个简单的响应
                        # 使用 chat_completion 而不是 chat
                        messages = [{"role": "user", "content": "Hello"}]
                        provider_name = config.llm.provider
                        
                        # 如果 config.llm.provider 是空的，直接报错
                        if not provider_name:
                             return {
                                'success': False,
                                'message': 'LLM Provider 未配置，请先配置 Model Adapter'
                            }
                            
                        # 确保 Provider 已经加载
                        try:
                             adapter.get_provider(provider_name)
                        except ValueError:
                             # 如果 Provider 不存在，尝试重新加载配置
                             adapter._load_saved_configs()
                        
                        adapter.chat_completion(
                            messages=messages, 
                            provider=provider_name,
                            model=config.llm.model_name
                        )
                        return {
                            'success': True,
                            'message': 'LLM 配置重新加载并测试成功 (via Model Adapter)'
                        }
                    except Exception as e:
                        # 如果 Model Adapter 测试失败，尝试旧的测试方法作为回退
                         # 重新测试连接
                        result = self.test_llm_connection()
                        if result['success']:
                             return {
                                'success': True,
                                'message': 'LLM 配置重新加载并测试成功 (Legacy Test)'
                            }
                        else:
                            return {
                                'success': False,
                                'message': f"LLM 连接测试失败: {str(e)}"
                            }
                except Exception as e:
                     return {
                        'success': False,
                        'message': f'LLM 重新加载失败: {str(e)}'
                    }

            else:
                return {
                    'success': False,
                    'message': f'未知服务: {service_name}'
                }
                
        except Exception as e:
            logger.error(f'重新初始化服务失败: {e}')
            raise


# 全局单例
_config_service = None


def get_config_service():
    """获取配置服务单例"""
    global _config_service
    if _config_service is None:
        _config_service = ConfigService()
    return _config_service

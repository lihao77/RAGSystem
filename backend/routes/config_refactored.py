# -*- coding: utf-8 -*-
"""
配置管理路由 - 配置读取、更新、验证和测试功能（重构版）

原始版本已备份到 config.py.backup
此版本使用服务层架构，路由只负责请求响应转发
注意：保持所有返回格式与原版完全一致
"""

from flask import Blueprint, request, jsonify
import logging
from services.config_service import get_config_service

logger = logging.getLogger(__name__)

config_bp = Blueprint('config', __name__)


@config_bp.route('/', methods=['GET'])
def get_current_config():
    """获取当前配置（隐藏敏感信息）"""
    try:
        service = get_config_service()
        config_dict = service.get_config_dict(hide_sensitive=True)
        
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
        service = get_config_service()
        result = service.get_raw_config()
        
        return jsonify({
            'success': True,
            'data': result['data'],
            'content': result['content']
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
        
        service = get_config_service()
        service.update_config(data)
        
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
        
        service = get_config_service()
        validation_result = service.validate_config(data)
        
        return jsonify({
            'success': True,
            'message': '配置格式验证通过',
            'data': validation_result
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
        neo4j_config = data.get('neo4j')
        
        service = get_config_service()
        result = service.test_neo4j_connection(neo4j_config)
        
        if result['success']:
            return jsonify(result)
        else:
            return jsonify(result), 500
            
    except Exception as e:
        logger.error(f'Neo4j 连接测试异常: {e}')
        return jsonify({
            'success': False,
            'message': f'连接测试异常: {str(e)}'
        }), 500


@config_bp.route('/test/llm', methods=['POST'])
def test_llm_connection():
    """测试LLM API连接"""
    try:
        data = request.get_json() or {}
        llm_config = data.get('llm')
        
        service = get_config_service()
        result = service.test_llm_connection(llm_config)
        
        if result['success']:
            return jsonify(result)
        else:
            return jsonify(result), 400 if 'API' in result['message'] else 500
            
    except Exception as e:
        logger.error(f'LLM 连接测试异常: {e}')
        return jsonify({
            'success': False,
            'message': f'连接测试异常: {str(e)}'
        }), 500


@config_bp.route('/reload', methods=['POST'])
def reload_config_api():
    """热重载配置"""
    try:
        service = get_config_service()
        config_dict = service.reload_config()
        
        return jsonify({
            'success': True,
            'message': '配置已重新加载',
            'data': config_dict
        })
        
    except Exception as e:
        logger.error(f'重载配置失败: {e}')
        return jsonify({
            'success': False,
            'message': f'重载配置失败: {str(e)}'
        }), 500


@config_bp.route('/export', methods=['GET'])
def export_config():
    """导出配置文件"""
    try:
        service = get_config_service()
        result = service.export_config()
        
        if result is None:
            return jsonify({
                'success': False,
                'message': '配置文件不存在'
            }), 404
        
        content, filename = result
        return jsonify({
            'success': True,
            'data': content,
            'filename': filename
        })
        
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
        service = get_config_service()
        schema = service.get_config_schema()
        
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


@config_bp.route('/services/status', methods=['GET'])
def get_services_status():
    """获取各服务的状态"""
    try:
        service = get_config_service()
        status = service.get_services_status()
        
        return jsonify({
            'success': True,
            'data': status
        })
        
    except Exception as e:
        logger.error(f'获取服务状态失败: {e}')
        return jsonify({
            'success': False,
            'message': f'获取服务状态失败: {str(e)}'
        }), 500


@config_bp.route('/services/<service_name>/reinit', methods=['POST'])
def reinit_service(service_name):
    """重新初始化指定服务"""
    try:
        service = get_config_service()
        result = service.reinit_service(service_name)
        
        if result['success']:
            return jsonify(result)
        else:
            return jsonify(result), 500
            
    except Exception as e:
        logger.error(f'重新初始化服务失败: {e}')
        return jsonify({
            'success': False,
            'message': f'重新初始化失败: {str(e)}'
        }), 500

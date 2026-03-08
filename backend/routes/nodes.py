# -*- coding: utf-8 -*-
"""
节点系统 API 路由。
"""

from flask import Blueprint, request
import logging

from execution.observability import ensure_request_id
from execution.adapters.node_execution import NodeExecutionAdapter
from services.node_service import NodeServiceError, get_node_service
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

nodes_bp = Blueprint('nodes', __name__, url_prefix='/api/nodes')


@nodes_bp.route('/types', methods=['GET'])
def list_node_types():
    """列出所有可用节点类型。"""
    try:
        nodes = get_node_service().list_node_types()
        return success_response(data=nodes, nodes=nodes, message='获取节点类型成功')
    except Exception as error:
        logger.error('获取节点类型失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/types/<node_type>', methods=['GET'])
def get_node_type(node_type):
    """获取节点类型详情。"""
    try:
        node = get_node_service().get_node_type(node_type)
        return success_response(data=node, node=node, message='获取节点详情成功')
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except Exception as error:
        logger.error('获取节点详情失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/types/<node_type>/default-config', methods=['GET'])
def get_default_config(node_type):
    """获取节点默认配置。"""
    try:
        config = get_node_service().get_default_config(node_type)
        return success_response(data=config, config=config, message='获取默认配置成功')
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except Exception as error:
        logger.error('获取节点默认配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/types/<node_type>/config-schema', methods=['GET'])
def get_config_schema(node_type):
    """获取节点配置 Schema。"""
    try:
        schema = get_node_service().get_config_schema(node_type)
        return success_response(data=schema, schema=schema, message='获取配置 Schema 成功')
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except Exception as error:
        logger.error('获取配置 Schema 失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/data-types', methods=['GET'])
def get_data_types():
    """获取所有节点使用的数据类型。"""
    try:
        data = get_node_service().get_data_types()
        return success_response(data=data, message='获取数据类型成功')
    except Exception as error:
        logger.error('获取数据类型失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/configs', methods=['GET'])
def list_configs():
    """列出所有保存的配置。"""
    try:
        node_type = request.args.get('node_type')
        include_presets = request.args.get('include_presets', 'true').lower() == 'true'
        configs = get_node_service().list_configs(node_type, include_presets)
        return success_response(data=configs, configs=configs, message='获取配置列表成功')
    except Exception as error:
        logger.error('获取配置列表失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/configs', methods=['POST'])
def save_config():
    """保存节点配置。"""
    try:
        result = get_node_service().save_config(request.get_json(silent=True))
        return success_response(data=result, message='保存配置成功', **result)
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except Exception as error:
        logger.error('保存节点配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/configs/<config_id>', methods=['GET'])
def get_config(config_id):
    """获取配置详情。"""
    try:
        result = get_node_service().get_config(config_id)
        return success_response(data=result, message='获取配置成功', **result)
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except Exception as error:
        logger.error('获取配置详情失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/configs/<config_id>', methods=['DELETE'])
def delete_config(config_id):
    """删除配置。"""
    try:
        get_node_service().delete_config(config_id)
        return success_response(message='删除配置成功')
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except Exception as error:
        logger.error('删除配置失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/execute', methods=['POST'])
def execute_node():
    """执行节点。"""
    try:
        payload = request.get_json(silent=True) or {}
        outputs = NodeExecutionAdapter().execute(
            payload,
            node_service=get_node_service(),
            session_id=payload.get('session_id'),
            run_id=payload.get('run_id'),
            request_id=ensure_request_id(request.headers.get('X-Request-ID')),
        )
        return success_response(data=outputs, outputs=outputs, message='执行成功')
    except NodeServiceError as error:
        return error_response(message=error.message, error=error.message, status_code=error.status_code, **error.payload)
    except TimeoutError as error:
        return error_response(message=str(error), error=str(error), status_code=504)
    except Exception as error:
        logger.error('执行节点失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)


@nodes_bp.route('/processors/builtin', methods=['GET'])
def list_builtin_processors():
    """列出内置处理器。"""
    try:
        processors = get_node_service().list_builtin_processors()
        return success_response(data=processors, processors=processors, message='获取内置处理器成功')
    except Exception as error:
        logger.error('获取内置处理器失败: %s', error, exc_info=True)
        return error_response(message=str(error), error=str(error), status_code=500)

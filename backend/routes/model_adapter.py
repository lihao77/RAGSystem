"""
Model Adapter API Routes

提供 Model Adapter 配置管理的 REST API 接口。
"""

from flask import Blueprint, request
import logging

from services.model_adapter_service import (
    ModelAdapterServiceError,
    get_model_adapter_service,
)
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

model_adapter_bp = Blueprint('model_adapter', __name__)


@model_adapter_bp.route('/providers', methods=['GET'])
def get_providers():
    """获取所有 Provider 列表。"""
    try:
        providers = get_model_adapter_service().list_providers()
        return success_response(
            data=providers,
            providers=providers,
            message='Provider 列表获取成功',
        )
    except Exception as error:
        logger.error('获取 Provider 列表失败: %s', error, exc_info=True)
        return error_response(message=f'获取 Provider 列表失败: {error}', status_code=500)


@model_adapter_bp.route('/providers', methods=['POST'])
def create_provider():
    """创建新的 Provider。"""
    try:
        provider_key = get_model_adapter_service().create_provider(request.get_json(silent=True))
        return success_response(
            data={'provider_key': provider_key},
            provider_key=provider_key,
            message='Provider 创建成功',
        )
    except ModelAdapterServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('创建 Provider 失败: %s', error, exc_info=True)
        return error_response(message=f'创建 Provider 失败: {error}', status_code=500)


@model_adapter_bp.route('/providers/<provider_key>', methods=['PUT'])
def update_provider(provider_key):
    """更新 Provider。"""
    try:
        updated_provider_key = get_model_adapter_service().update_provider(
            provider_key,
            request.get_json(silent=True),
        )
        return success_response(
            data={'provider_key': updated_provider_key},
            provider_key=updated_provider_key,
            message='Provider 更新成功',
        )
    except ModelAdapterServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('更新 Provider 失败: %s', error, exc_info=True)
        return error_response(message=f'更新 Provider 失败: {error}', status_code=500)


@model_adapter_bp.route('/providers/<provider_key>', methods=['DELETE'])
def delete_provider(provider_key):
    """删除 Provider。"""
    try:
        get_model_adapter_service().delete_provider(provider_key)
        return success_response(message='Provider 删除成功')
    except ModelAdapterServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('删除 Provider 失败: %s', error, exc_info=True)
        return error_response(message=f'删除 Provider 失败: {error}', status_code=500)


@model_adapter_bp.route('/providers/<provider_key>/check', methods=['GET'])
def check_provider_availability(provider_key):
    """检查 Provider 可用性（按需调用）。"""
    try:
        result = get_model_adapter_service().check_provider_availability(provider_key)
        return success_response(data=result, message='检查成功', **result)
    except ModelAdapterServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('检查 Provider 可用性失败: %s', error, exc_info=True)
        return error_response(message=f'检查失败: {error}', status_code=500)


@model_adapter_bp.route('/test', methods=['POST'])
def test_provider():
    """测试 Provider。"""
    try:
        result = get_model_adapter_service().test_provider(request.get_json(silent=True))
        return success_response(data=result, response=result, message='测试成功')
    except ModelAdapterServiceError as error:
        return error_response(message=error.message, status_code=error.status_code)
    except Exception as error:
        logger.error('测试 Provider 失败: %s', error, exc_info=True)
        return error_response(message=f'测试 Provider 失败: {error}', status_code=500)

# -*- coding: utf-8 -*-
"""
响应格式化工具 - 统一API响应格式
"""

from flask import jsonify
import logging

logger = logging.getLogger(__name__)


def success_response(data=None, message='操作成功', **kwargs):
    """成功响应"""
    response = {
        'success': True,
        'message': message
    }
    if data is not None:
        response['data'] = data
    response.update(kwargs)
    return jsonify(response)


def error_response(message='操作失败', status_code=400, **kwargs):
    """错误响应"""
    response = {
        'success': False,
        'message': message
    }
    response.update(kwargs)
    return jsonify(response), status_code


def paginated_response(items, total, page=1, page_size=10, **kwargs):
    """分页响应"""
    return success_response(
        data=items,
        pagination={
            'total': total,
            'page': page,
            'page_size': page_size,
            'total_pages': (total + page_size - 1) // page_size
        },
        **kwargs
    )

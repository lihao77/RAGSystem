# -*- coding: utf-8 -*-
"""
Pydantic 通用响应模型。
"""

from typing import Any, Generic, List, Optional, TypeVar

from pydantic import BaseModel

T = TypeVar('T')


class SuccessResponse(BaseModel, Generic[T]):
    """标准成功响应。"""
    success: bool = True
    message: str = 'success'
    data: Optional[T] = None


class ErrorResponse(BaseModel):
    """标准错误响应。"""
    success: bool = False
    message: str
    details: Optional[List[str]] = None


class PaginatedResponse(BaseModel, Generic[T]):
    """分页响应。"""
    success: bool = True
    message: str = 'success'
    data: List[T]
    total: Optional[int] = None
    limit: int
    offset: int


def ok(data: Any = None, message: str = 'success') -> dict:
    """构建标准成功响应字典。"""
    resp = {'success': True, 'message': message}
    if data is not None:
        resp['data'] = data
    return resp


def err(message: str, status_code: int = 400) -> tuple:
    """构建标准错误响应元组 (dict, status_code)。"""
    return {'success': False, 'message': message}, status_code

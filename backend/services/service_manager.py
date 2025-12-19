#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
服务管理器 - 延迟初始化和健康检查
"""

import logging
from typing import Optional, Dict, Any
from enum import Enum

logger = logging.getLogger(__name__)


class ServiceStatus(Enum):
    """服务状态枚举"""
    NOT_CONFIGURED = "not_configured"  # 未配置
    NOT_INITIALIZED = "not_initialized"  # 未初始化
    INITIALIZING = "initializing"  # 初始化中
    READY = "ready"  # 已就绪
    ERROR = "error"  # 错误


class ServiceManager:
    """服务管理器 - 管理各个服务的延迟初始化"""
    
    def __init__(self):
        self._services = {}
        self._status = {}
        self._errors = {}
    
    def register_service(self, service_name: str, init_func: callable, 
                         check_config_func: callable = None):
        """
        注册服务
        
        Args:
            service_name: 服务名称
            init_func: 初始化函数
            check_config_func: 配置检查函数（可选）
        """
        self._services[service_name] = {
            'init_func': init_func,
            'check_config_func': check_config_func,
            'instance': None
        }
        
        # 检查是否已配置
        if check_config_func:
            is_configured = check_config_func()
            self._status[service_name] = ServiceStatus.NOT_INITIALIZED if is_configured else ServiceStatus.NOT_CONFIGURED
        else:
            self._status[service_name] = ServiceStatus.NOT_INITIALIZED
    
    def get_service(self, service_name: str) -> Optional[Any]:
        """
        获取服务实例（如果未初始化则自动初始化）
        
        Args:
            service_name: 服务名称
            
        Returns:
            服务实例，如果初始化失败返回 None
        """
        if service_name not in self._services:
            logger.error(f"服务未注册: {service_name}")
            return None
        
        service = self._services[service_name]
        
        # 如果已经初始化，直接返回
        if service['instance'] is not None:
            return service['instance']
        
        # 检查配置
        if self._status[service_name] == ServiceStatus.NOT_CONFIGURED:
            logger.warning(f"服务未配置: {service_name}")
            return None
        
        # 执行初始化
        return self._initialize_service(service_name)
    
    def _initialize_service(self, service_name: str) -> Optional[Any]:
        """
        初始化服务
        
        Args:
            service_name: 服务名称
            
        Returns:
            服务实例，如果初始化失败返回 None
        """
        service = self._services[service_name]
        
        try:
            logger.info(f"正在初始化服务: {service_name}")
            self._status[service_name] = ServiceStatus.INITIALIZING
            
            # 执行初始化
            instance = service['init_func']()
            
            if instance is not None:
                service['instance'] = instance
                self._status[service_name] = ServiceStatus.READY
                self._errors[service_name] = None
                logger.info(f"✓ 服务初始化成功: {service_name}")
                return instance
            else:
                self._status[service_name] = ServiceStatus.ERROR
                self._errors[service_name] = "初始化返回 None"
                logger.error(f"✗ 服务初始化失败: {service_name}")
                return None
                
        except Exception as e:
            self._status[service_name] = ServiceStatus.ERROR
            self._errors[service_name] = str(e)
            logger.error(f"✗ 服务初始化异常: {service_name} - {e}")
            return None
    
    def get_status(self, service_name: str) -> Dict[str, Any]:
        """
        获取服务状态
        
        Args:
            service_name: 服务名称
            
        Returns:
            服务状态信息
        """
        if service_name not in self._services:
            return {
                'status': 'unknown',
                'error': '服务未注册'
            }
        
        status = self._status[service_name]
        return {
            'status': status.value,
            'error': self._errors.get(service_name),
            'is_ready': status == ServiceStatus.READY
        }
    
    def get_all_status(self) -> Dict[str, Dict[str, Any]]:
        """
        获取所有服务状态
        
        Returns:
            所有服务的状态信息
        """
        return {
            name: self.get_status(name)
            for name in self._services.keys()
        }
    
    def reinitialize_service(self, service_name: str) -> bool:
        """
        重新初始化服务
        
        Args:
            service_name: 服务名称
            
        Returns:
            是否初始化成功
        """
        if service_name not in self._services:
            logger.error(f"服务未注册: {service_name}")
            return False
        
        # 清理现有实例
        service = self._services[service_name]
        if service['instance'] is not None:
            # 尝试清理资源
            if hasattr(service['instance'], 'close'):
                try:
                    service['instance'].close()
                except Exception as e:
                    logger.warning(f"清理服务资源失败: {service_name} - {e}")
            
            service['instance'] = None
        
        # 重新检查配置
        if service['check_config_func']:
            is_configured = service['check_config_func']()
            self._status[service_name] = ServiceStatus.NOT_INITIALIZED if is_configured else ServiceStatus.NOT_CONFIGURED
        
        # 如果已配置，则初始化
        if self._status[service_name] != ServiceStatus.NOT_CONFIGURED:
            instance = self._initialize_service(service_name)
            return instance is not None
        
        return False


# 全局服务管理器实例
_service_manager = ServiceManager()


def get_service_manager() -> ServiceManager:
    """获取全局服务管理器实例"""
    return _service_manager

# -*- coding: utf-8 -*-
"""
扩展基类 - 所有 RAGSystem 扩展的基础接口。

下游项目继承 BaseExtension，只需覆盖感兴趣的方法。
"""


class BaseExtension:
    """扩展基类，所有方法均有默认空实现，插件只需覆盖感兴趣的方法。"""

    name: str = "unnamed_extension"

    def get_tool_contracts(self) -> list:
        """返回扩展提供的工具契约列表。"""
        return []

    def get_observation_formatters(self) -> list:
        """返回扩展提供的 ObservationFormatter 实例列表。"""
        return []

    def get_api_routers(self) -> list:
        """返回扩展提供的 API 路由列表，格式：[(router, prefix, tag), ...]"""
        return []

    def get_skills_dirs(self) -> list:
        """返回扩展提供的 Skills 目录绝对路径列表。"""
        return []

    async def on_startup(self, container) -> None:
        """应用启动钩子，此时所有核心服务已就绪。"""
        pass

    async def on_shutdown(self, container) -> None:
        """应用关闭钩子。"""
        pass

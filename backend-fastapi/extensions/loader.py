# -*- coding: utf-8 -*-
"""
扩展加载器 - 通过 importlib.metadata Entry Points 发现并加载已安装扩展。

下游项目在 pyproject.toml 中声明：
[project.entry-points."ragsystem.extensions"]
geoplus = "geoplus.extension:GeoPlusExtension"
"""

import logging

logger = logging.getLogger(__name__)

EP_GROUP = "ragsystem.extensions"


def discover_extensions() -> list:
    """通过 Entry Points 发现并实例化所有已安装扩展。"""
    from importlib.metadata import entry_points
    from extensions.base import BaseExtension

    eps = entry_points(group=EP_GROUP)
    loaded = []
    for ep in eps:
        try:
            ext = ep.load()()
            if not isinstance(ext, BaseExtension):
                logger.warning("扩展 %s 不是 BaseExtension 子类，已跳过", ep.name)
                continue
            loaded.append(ext)
            logger.info("已加载扩展: %s (%s)", ep.name, type(ext).__name__)
        except Exception as e:
            logger.warning("扩展 %s 加载失败，已跳过: %s", ep.name, e)
    return loaded

# -*- coding: utf-8 -*-
"""
统一日志配置入口。
"""

from __future__ import annotations

import logging
import os
import sys

_DEFAULT_LOG_LEVEL = logging.INFO
_LOG_FORMAT = '%(asctime)s - %(levelname)s - %(name)s - %(message)s'


def resolve_log_level() -> int:
    raw = str(os.getenv('LOG_LEVEL', 'INFO') or 'INFO').strip().upper()
    return getattr(logging, raw, _DEFAULT_LOG_LEVEL)


_configured = False


def setup_logging() -> None:
    """统一配置 root logger，幂等——仅首次调用生效。"""
    global _configured
    if _configured:
        return
    root = logging.getLogger()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.handlers = [handler]
    root.setLevel(resolve_log_level())
    _configured = True

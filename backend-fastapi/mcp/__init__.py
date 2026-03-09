# -*- coding: utf-8 -*-
"""
MCP (Model Context Protocol) Client 集成模块

让智能体连接外部 MCP Server，调用第三方工具。

注意：本项目本地包名同样叫 `mcp`，会与 pip 安装的官方 `mcp`
SDK 顶层模块重名。这里通过扩展当前包的 `__path__`，让解释器同时能
找到本地业务模块和 site-packages 中的官方 SDK 子模块，例如
`mcp.client.session`、`mcp.client.stdio`。
"""

from __future__ import annotations

import importlib
import importlib.metadata
from pathlib import Path
from typing import Optional

_EXTERNAL_MCP_SDK_DIR: Optional[Path] = None
_EXTERNAL_MCP_SDK_ERROR: Optional[Exception] = None


def _find_external_mcp_sdk_dir() -> Optional[Path]:
    """Locate the site-packages `mcp` package installed via pip."""
    global _EXTERNAL_MCP_SDK_ERROR

    try:
        dist = importlib.metadata.distribution("mcp")
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception as exc:
        _EXTERNAL_MCP_SDK_ERROR = exc
        return None

    try:
        sdk_dir = Path(dist.locate_file("mcp")).resolve()
    except Exception as exc:
        _EXTERNAL_MCP_SDK_ERROR = exc
        return None

    local_dir = Path(__file__).resolve().parent
    if sdk_dir == local_dir:
        return None

    if not (sdk_dir / "__init__.py").exists():
        return None

    return sdk_dir


def _extend_package_path() -> None:
    """Expose official SDK submodules under this local package namespace."""
    global _EXTERNAL_MCP_SDK_DIR, _EXTERNAL_MCP_SDK_ERROR

    if _EXTERNAL_MCP_SDK_DIR is not None:
        return
    if _EXTERNAL_MCP_SDK_ERROR is not None:
        return

    sdk_dir = _find_external_mcp_sdk_dir()
    if sdk_dir is None:
        if _EXTERNAL_MCP_SDK_ERROR is None:
            _EXTERNAL_MCP_SDK_ERROR = ImportError("pip 安装的 `mcp` SDK 未找到")
        return

    if str(sdk_dir) not in __path__:
        __path__.append(str(sdk_dir))
    _EXTERNAL_MCP_SDK_DIR = sdk_dir


def get_mcp_sdk_import_error() -> Optional[Exception]:
    """Return the stored MCP SDK import error, if any."""
    return _EXTERNAL_MCP_SDK_ERROR


def __getattr__(name: str):
    """Lazily expose a few common SDK symbols from the official package."""
    _extend_package_path()
    if _EXTERNAL_MCP_SDK_ERROR is not None:
        raise AttributeError(name) from _EXTERNAL_MCP_SDK_ERROR

    mapping = {
        "ClientSession": ("mcp.client.session", "ClientSession"),
        "StdioServerParameters": ("mcp.client.stdio", "StdioServerParameters"),
    }
    target = mapping.get(name)
    if target is None:
        raise AttributeError(name)

    module_name, attr_name = target
    module = importlib.import_module(module_name)
    value = getattr(module, attr_name)
    globals()[name] = value
    return value


_extend_package_path()

from .client_manager import get_mcp_manager

__all__ = ["get_mcp_manager", "get_mcp_sdk_import_error"]

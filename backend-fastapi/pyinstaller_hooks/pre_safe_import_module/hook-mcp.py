# -*- coding: utf-8 -*-
"""
Let PyInstaller see the official MCP SDK under this project's local `mcp` package.

The backend owns `backend-fastapi/mcp`, while the pip package `mcp` also uses the
same top-level module name. At runtime, `backend-fastapi/mcp/__init__.py`
extends `__path__` so imports such as `mcp.client.session` resolve to the SDK.
PyInstaller's static module graph does not observe that path mutation reliably,
so this hook mirrors it before hidden imports are analyzed.
"""

from __future__ import annotations

import importlib.metadata
from pathlib import Path


def pre_safe_import_module(api):
    try:
        dist = importlib.metadata.distribution("mcp")
        sdk_dir = Path(dist.locate_file("mcp")).resolve()
    except Exception:
        return

    if not (sdk_dir / "__init__.py").exists():
        return

    api.append_package_path(str(sdk_dir))

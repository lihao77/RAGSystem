# -*- coding: utf-8 -*-
"""pytest 配置：确保 backend 在 Python 路径中，以便导入 config、model_adapter 等包。"""
import sys
from pathlib import Path

_backend_root = Path(__file__).resolve().parent.parent
if str(_backend_root) not in sys.path:
    sys.path.insert(0, str(_backend_root))

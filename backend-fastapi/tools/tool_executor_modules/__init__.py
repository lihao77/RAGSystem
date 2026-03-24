# -*- coding: utf-8 -*-
"""Legacy namespace kept minimal during tools cleanup."""

from tools.runtime.executor import execute_tool
from tools.runtime.registration import TOOL_HANDLERS

__all__ = ["execute_tool", "TOOL_HANDLERS"]

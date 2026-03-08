# -*- coding: utf-8 -*-
"""dispatcher 中 MCP 路径的轻量 guard 测试。"""

from __future__ import annotations

import unittest
from pathlib import Path


class MCPDispatcherGuardTest(unittest.TestCase):
    def test_dispatcher_routes_mcp_tools_via_mcp_service(self) -> None:
        dispatcher_path = Path(__file__).resolve().parent.parent / 'tools' / 'tool_executor_modules' / 'dispatcher.py'
        content = dispatcher_path.read_text(encoding='utf-8')

        self.assertIn("from services.mcp_service import get_mcp_service", content)
        self.assertIn("get_mcp_service().call_tool(server_name, original_tool, arguments, session_id=session_id)", content)
        self.assertIn("result = _execute_mcp_tool(tool_name, arguments, session_id=session_id)", content)


if __name__ == '__main__':
    unittest.main()

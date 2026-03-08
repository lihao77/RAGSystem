# -*- coding: utf-8 -*-
"""MCP HTTP transport compatibility tests."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from mcp.client_manager import MCPClientManager


class MCPClientManagerTransportTest(unittest.TestCase):
    def test_extract_transport_streams_accepts_two_values(self) -> None:
        read, write = MCPClientManager._extract_transport_streams((object(), object()))

        self.assertIsNotNone(read)
        self.assertIsNotNone(write)

    def test_extract_transport_streams_accepts_extra_session_metadata(self) -> None:
        expected_read = object()
        expected_write = object()

        read, write = MCPClientManager._extract_transport_streams(
            (expected_read, expected_write, "session-id")
        )

        self.assertIs(read, expected_read)
        self.assertIs(write, expected_write)

    def test_extract_transport_streams_rejects_incomplete_tuple(self) -> None:
        with self.assertRaises(ValueError):
            MCPClientManager._extract_transport_streams((object(),))

    def test_format_exception_message_uses_class_name_when_str_empty(self) -> None:
        message = MCPClientManager._format_exception_message(AssertionError())

        self.assertEqual(message, 'AssertionError')

    def test_format_exception_message_includes_cause(self) -> None:
        try:
            try:
                raise RuntimeError('inner boom')
            except RuntimeError as error:
                raise AssertionError() from error
        except AssertionError as error:
            message = MCPClientManager._format_exception_message(error)

        self.assertEqual(message, 'AssertionError | caused by: inner boom')


if __name__ == '__main__':
    unittest.main()

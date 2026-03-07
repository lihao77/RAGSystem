# -*- coding: utf-8 -*-
"""共享 YAML 文件存储 helper 测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from utils.yaml_store import load_yaml_file, save_yaml_file


class YamlStoreTest(unittest.TestCase):
    def test_load_missing_file_returns_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'missing.yaml'
            data = load_yaml_file(path, default_factory=dict)
            self.assertEqual(data, {})

    def test_save_yaml_file_writes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'nested' / 'config.yaml'
            save_yaml_file(path, {'name': 'demo', 'enabled': True}, sort_keys=False)

            data = load_yaml_file(path, default_factory=dict)
            self.assertEqual(data, {'name': 'demo', 'enabled': True})

    def test_save_yaml_file_overwrites_existing_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'config.yaml'
            save_yaml_file(path, {'version': 1}, sort_keys=False)
            save_yaml_file(path, {'version': 2, 'items': ['a', 'b']}, sort_keys=False)

            data = load_yaml_file(path, default_factory=dict)
            self.assertEqual(data, {'version': 2, 'items': ['a', 'b']})


if __name__ == '__main__':
    unittest.main()

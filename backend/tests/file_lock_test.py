# -*- coding: utf-8 -*-
"""FileLock 测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from utils.file_lock import FileLock


class FileLockTest(unittest.TestCase):
    def test_lock_file_created_and_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'config.yaml'
            lock_path = Path(tmp) / '.config.yaml.lock'

            with FileLock(path):
                self.assertTrue(lock_path.exists())

            self.assertFalse(lock_path.exists())

    def test_lock_is_reentrant_in_same_thread(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'config.yaml'
            lock_path = Path(tmp) / '.config.yaml.lock'

            with FileLock(path):
                with FileLock(path):
                    self.assertTrue(lock_path.exists())

            self.assertFalse(lock_path.exists())


if __name__ == '__main__':
    unittest.main()

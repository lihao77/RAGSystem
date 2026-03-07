# -*- coding: utf-8 -*-
"""FileIndex YAML 存储测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from file_index.store import FileIndex


class FileIndexStoreTest(unittest.TestCase):
    def test_add_and_delete_file_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'files.yaml'
            index = FileIndex(index_path=path)

            record = index.add(
                original_name='demo.txt',
                stored_name='abc.txt',
                stored_path='/tmp/abc.txt',
                size=123,
                mime='text/plain',
            )

            self.assertEqual(index.get(record['id'])['stored_name'], 'abc.txt')
            self.assertTrue(path.exists())

            deleted = index.delete(record['id'])
            self.assertTrue(deleted)
            self.assertIsNone(index.get(record['id']))


if __name__ == '__main__':
    unittest.main()

# -*- coding: utf-8 -*-
"""ModelAdapterConfigStore 文件存储测试。"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))
_MODULE_PATH = _BACKEND_ROOT / 'model_adapter' / 'config_store.py'
_SPEC = importlib.util.spec_from_file_location('model_adapter_config_store_for_test', _MODULE_PATH)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC is not None and _SPEC.loader is not None
_SPEC.loader.exec_module(_MODULE)
ModelAdapterConfigStore = _MODULE.ModelAdapterConfigStore


class ModelAdapterConfigStoreTest(unittest.TestCase):
    def test_save_load_and_delete_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'providers.yaml'
            store = ModelAdapterConfigStore(config_file=path)

            store.save_provider('demo_openai', {'name': 'demo', 'provider_type': 'openai'})
            self.assertTrue(store.exists('demo_openai'))
            self.assertEqual(
                store.get_provider('demo_openai'),
                {'name': 'demo', 'provider_type': 'openai'},
            )

            deleted = store.delete_provider('demo_openai')
            self.assertTrue(deleted)
            self.assertFalse(store.exists('demo_openai'))

    def test_load_all_returns_empty_dict_for_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'providers.yaml'
            store = ModelAdapterConfigStore(config_file=path)
            self.assertEqual(store.load_all(), {})


if __name__ == '__main__':
    unittest.main()

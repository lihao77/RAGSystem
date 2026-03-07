# -*- coding: utf-8 -*-
"""VectorizerConfigStore 存储测试。"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

_MODULE_PATH = _BACKEND_ROOT / 'vector_store' / 'vectorizer_config.py'
_SPEC = importlib.util.spec_from_file_location('vectorizer_config_for_test', _MODULE_PATH)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC is not None and _SPEC.loader is not None
_SPEC.loader.exec_module(_MODULE)
VectorizerConfigStore = _MODULE.VectorizerConfigStore


class VectorizerConfigStoreTest(unittest.TestCase):
    def test_add_activate_and_delete_vectorizer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'vectorizers.yaml'
            store = VectorizerConfigStore(config_path=path)

            key = store.add_vectorizer('demo_provider', 'demo-model')
            self.assertEqual(store.get_active_key(), key)
            self.assertTrue(path.exists())

            store.set_active_key(key)
            config = store.get_vectorizer(key)
            self.assertIsNotNone(config)
            self.assertTrue(config['is_active'])

            store.delete_vectorizer(key)
            self.assertIsNone(store.get_active_key())
            self.assertIsNone(store.get_vectorizer(key))

    def test_invalid_payload_is_migrated_to_default_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'vectorizers.yaml'
            path.write_text('[]\n', encoding='utf-8')
            store = VectorizerConfigStore(config_path=path)
            self.assertIsNone(store.get_active_key())
            self.assertEqual(store.list_vectorizers(), [])
            self.assertTrue(path.with_name('vectorizers.backup.yaml').exists())


if __name__ == '__main__':
    unittest.main()

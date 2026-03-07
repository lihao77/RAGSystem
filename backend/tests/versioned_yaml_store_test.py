# -*- coding: utf-8 -*-
"""Versioned YAML helper 测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from utils.versioned_yaml_store import (
    backup_yaml_file,
    build_backup_path,
    load_versioned_yaml_file,
    save_versioned_yaml_file,
)


class VersionedYamlStoreTest(unittest.TestCase):
    def test_build_backup_path_uses_backup_suffix(self) -> None:
        path = Path('/tmp/example.yaml')
        self.assertEqual(build_backup_path(path), Path('/tmp/example.backup.yaml'))

    def test_save_versioned_yaml_file_creates_backup_before_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'config.yaml'
            save_versioned_yaml_file(path, {'version': 1}, sort_keys=False)
            backup = save_versioned_yaml_file(path, {'version': 2}, backup=True, sort_keys=False)

            self.assertEqual(backup, path.with_name('config.backup.yaml'))
            self.assertEqual(path.read_text(encoding='utf-8').strip(), 'version: 2')
            self.assertEqual(backup.read_text(encoding='utf-8').strip(), 'version: 1')

    def test_load_versioned_yaml_file_persists_migration_and_backup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'workflow.yaml'
            path.write_text('schema_version: 1\nname: demo\n', encoding='utf-8')

            def migrate(data):
                payload = dict(data)
                changed = payload.get('schema_version') != 2
                payload['schema_version'] = 2
                payload['migrated'] = True
                return payload, changed

            data, changed = load_versioned_yaml_file(
                path,
                default_factory=dict,
                migrate=migrate,
                persist_on_change=True,
                backup_on_change=True,
                sort_keys=False,
            )

            backup_path = path.with_name('workflow.backup.yaml')
            self.assertTrue(changed)
            self.assertEqual(data['schema_version'], 2)
            self.assertTrue(data['migrated'])
            self.assertTrue(backup_path.exists())
            self.assertIn('schema_version: 1', backup_path.read_text(encoding='utf-8'))
            self.assertIn('schema_version: 2', path.read_text(encoding='utf-8'))

    def test_backup_yaml_file_returns_none_for_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'missing.yaml'
            self.assertIsNone(backup_yaml_file(path))


if __name__ == '__main__':
    unittest.main()

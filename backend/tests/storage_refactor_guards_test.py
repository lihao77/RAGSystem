# -*- coding: utf-8 -*-
"""P2 配置/存储基座静态守卫测试。"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent


class StorageRefactorGuardsTestCase(unittest.TestCase):
    def _parse(self, relative_path: str) -> ast.AST:
        return ast.parse((REPO_ROOT / relative_path).read_text(encoding='utf-8'))

    def _imported_modules(self, relative_path: str) -> set[str]:
        tree = self._parse(relative_path)
        imported = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        }
        imported.update(
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        )
        return imported

    def test_config_base_uses_shared_yaml_store(self):
        imported_modules = self._imported_modules('backend/config/base.py')
        self.assertIn('utils.yaml_store', imported_modules)
        self.assertNotIn('yaml', imported_modules)

    def test_config_schemas_uses_shared_yaml_store(self):
        imported_modules = self._imported_modules('backend/config/schemas.py')
        self.assertIn('utils.yaml_store', imported_modules)
        self.assertNotIn('yaml', imported_modules)

    def test_file_index_migration_uses_shared_yaml_store(self):
        imported_modules = self._imported_modules('backend/utils/migrate_file_index.py')
        self.assertIn('utils.yaml_store', imported_modules)
        self.assertNotIn('yaml', imported_modules)

    def test_agent_config_manager_separates_file_storage_and_text_import_export(self):
        tree = self._parse('backend/agents/config/manager.py')
        function_names = {
            node.name
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
        }
        self.assertIn('_render_config_text', function_names)
        self.assertIn('_parse_config_text', function_names)

        imported_modules = self._imported_modules('backend/agents/config/manager.py')
        self.assertIn('utils.versioned_yaml_store', imported_modules)
        self.assertIn('yaml', imported_modules)
        self.assertIn('json', imported_modules)


if __name__ == '__main__':
    unittest.main()

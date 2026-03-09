# -*- coding: utf-8 -*-
"""Agent-first 文档与依赖清理守卫测试。"""

from __future__ import annotations

import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parent.parent


class AgentFirstDocsAndRequirementsTestCase(unittest.TestCase):
    def test_env_example_uses_frontend_client_dist(self):
        content = (BACKEND_ROOT / '.env.example').read_text(encoding='utf-8')
        self.assertIn('FRONTEND_DIST=../frontend-client/dist', content)
        self.assertNotIn('NEO4J_URI', content)
        self.assertNotIn('NEO4J_USER', content)
        self.assertNotIn('NEO4J_PASSWORD', content)

    def test_requirements_remove_legacy_graph_dependencies(self):
        requirements = (BACKEND_ROOT / 'requirements.txt').read_text(encoding='utf-8')
        lock_requirements = (BACKEND_ROOT / 'requirements.lock.txt').read_text(encoding='utf-8')

        for content in (requirements, lock_requirements):
            self.assertNotIn('neo4j==', content)
            self.assertNotIn('llmjson', content)
            self.assertNotIn('json2graph', content)

    def test_new_requirements_snapshot_is_removed(self):
        self.assertFalse((BACKEND_ROOT / 'requirements_new.txt').exists())

    def test_neo4j_helper_module_is_removed(self):
        self.assertFalse((BACKEND_ROOT / 'utils' / 'neo4j_helpers.py').exists())

    def test_legacy_workflow_and_graph_runtime_modules_are_removed(self):
        self.assertFalse((BACKEND_ROOT / 'nodes').exists())
        self.assertFalse((BACKEND_ROOT / 'workflows').exists())
        self.assertFalse((BACKEND_ROOT / 'integrations' / 'json2graph').exists())
        self.assertFalse((BACKEND_ROOT / 'integrations' / 'llmjson').exists())


if __name__ == '__main__':
    unittest.main()

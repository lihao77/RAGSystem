# -*- coding: utf-8 -*-
"""智能体优先重构静态守卫测试。"""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

_BANNED_IMPORT_PREFIXES = (
    'db',
    'services.query_service',
    'services.search_service',
    'services.graphrag_service',
    'services.graphrag_api_service',
    'services.visualization_service',
    'services.node_service',
    'services.workflow_service',
    'routes.search_refactored',
    'routes.graphrag_refactored',
    'routes.visualization_refactored',
    'routes.nodes',
    'routes.workflows',
    'nodes',
    'workflows',
)

_BANNED_CALLS = {
    'get_session',
    'get_neo4j_connection',
}


class AgentFirstRefactorGuardsTestCase(unittest.TestCase):
    def _iter_python_files(self, relative_path: str):
        base_path = REPO_ROOT / relative_path
        if base_path.is_file():
            yield base_path
            return

        for path in base_path.rglob('*.py'):
            parts = set(path.relative_to(base_path).parts)
            if 'tests' in parts or 'docs' in parts or 'archive' in parts:
                continue
            yield path

    def _parse(self, path: Path) -> ast.AST:
        return ast.parse(path.read_text(encoding='utf-8'))

    def _collect_imports(self, tree: ast.AST) -> set[str]:
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

    def _collect_direct_called_names(self, tree: ast.AST) -> set[str]:
        called_names: set[str] = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name):
                called_names.add(node.func.id)
        return called_names

    def test_agent_core_boundaries_do_not_import_legacy_graph_or_workflow_layers(self):
        guarded_paths = [
            'backend/agents',
            'backend/routes/agent_api',
            'backend/services/agent_runtime_service.py',
            'backend/services/agent_api_runtime_service.py',
            'backend/services/agent_config_service.py',
            'backend/services/execution_service.py',
            'backend/services/mcp_service.py',
            'backend/services/model_adapter_service.py',
        ]

        violations: list[str] = []
        for relative_path in guarded_paths:
            for path in self._iter_python_files(relative_path):
                tree = self._parse(path)
                imports = self._collect_imports(tree)
                for module in sorted(imports):
                    if module.startswith(_BANNED_IMPORT_PREFIXES):
                        violations.append(f'{path.relative_to(REPO_ROOT)} imports {module}')

        self.assertEqual(violations, [])

    def test_agent_core_boundaries_do_not_call_neo4j_session_helpers(self):
        guarded_paths = [
            'backend/agents',
            'backend/routes/agent_api',
            'backend/services/agent_runtime_service.py',
            'backend/services/agent_api_runtime_service.py',
            'backend/services/agent_config_service.py',
            'backend/services/execution_service.py',
            'backend/services/mcp_service.py',
            'backend/services/model_adapter_service.py',
        ]

        violations: list[str] = []
        for relative_path in guarded_paths:
            for path in self._iter_python_files(relative_path):
                tree = self._parse(path)
                called_names = self._collect_direct_called_names(tree)
                banned_used = sorted(called_names & _BANNED_CALLS)
                if banned_used:
                    violations.append(f'{path.relative_to(REPO_ROOT)} calls {", ".join(banned_used)}')

        self.assertEqual(violations, [])

    def test_app_registers_core_blueprints_only(self):
        tree = self._parse(REPO_ROOT / 'backend/app.py')
        function_names = {
            node.name
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
        }

        self.assertIn('register_core_blueprints', function_names)
        self.assertIn('register_blueprints', function_names)
        self.assertNotIn('register_legacy_blueprints', function_names)

    def test_app_defaults_to_agent_first_surface(self):
        source = (REPO_ROOT / 'backend/app.py').read_text(encoding='utf-8')
        self.assertIn("frontend-client', 'dist'", source)
        self.assertNotIn('routes.nodes', source)
        self.assertNotIn('routes.search_refactored', source)
        self.assertNotIn('routes.graphrag_refactored', source)
        self.assertNotIn('RAGSYSTEM_ENABLE_LEGACY_BLUEPRINTS', source)
        self.assertNotIn('RAGSYSTEM_ENABLE_NEO4J_RUNTIME', source)

    def test_default_tool_definitions_exclude_legacy_graph_tools(self):
        from tools.function_definitions import get_tool_definitions

        tool_names = {
            tool.get('function', {}).get('name')
            for tool in get_tool_definitions()
        }

        self.assertNotIn('query_knowledge_graph_with_nl', tool_names)
        self.assertNotIn('search_knowledge_graph', tool_names)
        self.assertNotIn('get_entity_relations', tool_names)
        self.assertNotIn('execute_cypher_query', tool_names)
        self.assertNotIn('get_graph_schema', tool_names)
        self.assertNotIn('analyze_temporal_pattern', tool_names)
        self.assertNotIn('find_causal_chain', tool_names)
        self.assertNotIn('compare_entities', tool_names)
        self.assertNotIn('aggregate_statistics', tool_names)
        self.assertIn('read_document', tool_names)
        self.assertIn('generate_chart', tool_names)
        self.assertIn('execute_code', tool_names)

    def test_application_and_capabilities_layers_exist(self):
        self.assertTrue((REPO_ROOT / 'backend' / 'application').is_dir())
        self.assertTrue((REPO_ROOT / 'backend' / 'capabilities').is_dir())

    def test_core_routes_delegate_to_application_and_capabilities_layers(self):
        sessions_source = (REPO_ROOT / 'backend' / 'routes' / 'agent_api' / 'sessions.py').read_text(encoding='utf-8')
        vector_source = (REPO_ROOT / 'backend' / 'routes' / 'vector_library.py').read_text(encoding='utf-8')
        mcp_source = (REPO_ROOT / 'backend' / 'routes' / 'mcp.py').read_text(encoding='utf-8')

        self.assertIn('get_session_application', sessions_source)
        self.assertIn('get_collaboration_application', sessions_source)
        self.assertIn('get_vector_retrieval_capability', vector_source)
        self.assertIn('get_mcp_tools_capability', mcp_source)


if __name__ == '__main__':
    unittest.main()

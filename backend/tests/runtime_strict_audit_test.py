# -*- coding: utf-8 -*-
"""runtime_strict_audit 脚本测试。"""

from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

_MODULE_PATH = _BACKEND_ROOT / 'scripts' / 'runtime_strict_audit.py'
_SPEC = importlib.util.spec_from_file_location('runtime_strict_audit_for_test', _MODULE_PATH)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC is not None and _SPEC.loader is not None
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)

analyze_source = _MODULE.analyze_source
build_summary = _MODULE.build_summary
find_non_container_only_sites = _MODULE.find_non_container_only_sites
main = _MODULE.main
collect_runtime_dependency_sites = _MODULE.collect_runtime_dependency_sites


class RuntimeStrictAuditTest(unittest.TestCase):
    def test_analyze_source_collects_runtime_dependency_metadata(self) -> None:
        source = textwrap.dedent(
            '''
            def get_demo_service():
                return get_runtime_dependency(
                    container_getter='get_demo_service',
                    fallback_name='demo_service',
                    fallback_factory=DemoService,
                    legacy_getter=lambda: _demo_service,
                )

            def get_other_service():
                return get_runtime_dependency(
                    fallback_name='other_service',
                    fallback_factory=lambda: None,
                    container_resolver=lambda container: container.get_other_service(),
                    require_container=True,
                )
            '''
        )

        sites = analyze_source(source, path='backend/demo.py')

        self.assertEqual(len(sites), 2)
        self.assertEqual(sites[0].fallback_name, 'demo_service')
        self.assertEqual(sites[0].container_target, 'get_demo_service')
        self.assertTrue(sites[0].has_legacy_getter)
        self.assertEqual(sites[0].fallback_kind, 'legacy_getter')
        self.assertEqual(sites[1].fallback_kind, 'container_only')
        self.assertTrue(sites[1].has_container_resolver)

    def test_collect_runtime_dependency_sites_skips_tests_and_docs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_dir = root / 'backend'
            (backend_dir / 'pkg').mkdir(parents=True)
            (backend_dir / 'tests').mkdir(parents=True)
            (backend_dir / 'docs').mkdir(parents=True)

            (backend_dir / 'pkg' / 'demo.py').write_text(
                "def get_demo():\n    return get_runtime_dependency(fallback_name='demo', fallback_factory=Demo)\n",
                encoding='utf-8',
            )
            (backend_dir / 'tests' / 'test_demo.py').write_text(
                "def get_test():\n    return get_runtime_dependency(fallback_name='ignored', fallback_factory=Ignored)\n",
                encoding='utf-8',
            )
            (backend_dir / 'docs' / 'snippet.py').write_text(
                "def get_doc():\n    return get_runtime_dependency(fallback_name='ignored_doc', fallback_factory=IgnoredDoc)\n",
                encoding='utf-8',
            )

            sites = collect_runtime_dependency_sites(backend_dir)
            summary = build_summary(sites)

            self.assertEqual(summary['total_sites'], 1)
            self.assertEqual(sites[0].fallback_name, 'demo')


    def test_find_non_container_only_sites_returns_legacy_backlog(self) -> None:
        source = textwrap.dedent(
            '''
            def get_legacy_service():
                return get_runtime_dependency(
                    container_getter='get_legacy_service',
                    fallback_name='legacy_service',
                    fallback_factory=LegacyService,
                    legacy_getter=lambda: _legacy_service,
                )

            def get_container_only_service():
                return get_runtime_dependency(
                    container_getter='get_container_only_service',
                    fallback_name='container_only_service',
                    fallback_factory=ContainerOnlyService,
                    require_container=True,
                )
            '''
        )

        sites = analyze_source(source, path='backend/demo.py')
        backlog = find_non_container_only_sites(sites)

        self.assertEqual([site.fallback_name for site in backlog], ['legacy_service'])

    def test_main_check_container_only_fails_when_legacy_sites_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_dir = root / 'backend'
            (backend_dir / 'pkg').mkdir(parents=True)
            (backend_dir / 'pkg' / 'legacy.py').write_text(
                textwrap.dedent(
                    '''
                    def get_legacy_service():
                        return get_runtime_dependency(
                            container_getter='get_legacy_service',
                            fallback_name='legacy_service',
                            fallback_factory=LegacyService,
                            legacy_getter=lambda: _legacy_service,
                        )
                    '''
                ),
                encoding='utf-8',
            )

            stdout = io.StringIO()
            with patch.object(sys, 'argv', ['runtime_strict_audit.py', '--root', str(backend_dir), '--check-container-only']):
                with redirect_stdout(stdout):
                    exit_code = main()

            self.assertEqual(exit_code, 1)
            self.assertIn('FAILED: 1 non-container-only site(s) remain.', stdout.getvalue())

    def test_main_check_container_only_passes_when_all_sites_are_container_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_dir = root / 'backend'
            (backend_dir / 'pkg').mkdir(parents=True)
            (backend_dir / 'pkg' / 'strict.py').write_text(
                textwrap.dedent(
                    '''
                    def get_strict_service():
                        return get_runtime_dependency(
                            container_getter='get_strict_service',
                            fallback_name='strict_service',
                            fallback_factory=StrictService,
                            require_container=True,
                        )
                    '''
                ),
                encoding='utf-8',
            )

            stdout = io.StringIO()
            with patch.object(sys, 'argv', ['runtime_strict_audit.py', '--root', str(backend_dir), '--check-container-only']):
                with redirect_stdout(stdout):
                    exit_code = main()

            self.assertEqual(exit_code, 0)
            self.assertIn('PASS: all sites are container_only.', stdout.getvalue())

    def test_core_p1_targets_are_marked_container_only(self) -> None:
        sites = collect_runtime_dependency_sites(_BACKEND_ROOT)
        expected = {
            ('backend/config/__init__.py', 'config_manager'),
            ('backend/model_adapter/adapter.py', 'model_adapter'),
            ('backend/agents/config/manager.py', 'agent_config_manager'),
            ('backend/agents/task_registry.py', 'task_registry'),
            ('backend/agents/core/orchestrator.py', 'agent_orchestrator'),
            ('backend/agents/events/bus.py', 'event_bus'),
            ('backend/agents/events/session_manager.py', 'session_manager'),
            ('backend/mcp/client_manager.py', 'mcp_manager'),
            ('backend/mcp/config_store.py', 'mcp_config_store'),
            ('backend/services/agent_api_runtime_service.py', 'agent_api_runtime_service'),
            ('backend/services/agent_config_service.py', 'agent_config_service'),
            ('backend/services/agent_runtime_service.py', 'agent_runtime_service'),
            ('backend/services/embedding_model_service.py', 'embedding_model_service'),
            ('backend/services/mcp_service.py', 'mcp_service'),
            ('backend/services/model_adapter_service.py', 'model_adapter_service'),
            ('backend/services/vector_library_service.py', 'vector_library_service'),
            ('backend/services/vector_management_service.py', 'vector_management_service'),
        }

        statuses = {
            (site.path, site.fallback_name): site.fallback_kind
            for site in sites
            if (site.path, site.fallback_name) in expected
        }

        self.assertEqual(set(statuses.keys()), expected)
        self.assertTrue(all(kind == 'container_only' for kind in statuses.values()))


if __name__ == '__main__':
    unittest.main()

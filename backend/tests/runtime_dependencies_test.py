# -*- coding: utf-8 -*-
"""runtime.dependencies 严格模式与 fallback 诊断测试。"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from runtime.container import RuntimeContainer, set_current_runtime_container
from runtime.dependencies import (
    get_runtime_dependency,
    get_runtime_fallback_stats,
    reset_runtime_fallback_tracking,
)


class RuntimeDependenciesTest(unittest.TestCase):
    def setUp(self) -> None:
        self._previous_strict = os.environ.get('RAGSYSTEM_RUNTIME_STRICT')
        os.environ.pop('RAGSYSTEM_RUNTIME_STRICT', None)
        set_current_runtime_container(None)
        reset_runtime_fallback_tracking()

    def tearDown(self) -> None:
        if self._previous_strict is None:
            os.environ.pop('RAGSYSTEM_RUNTIME_STRICT', None)
        else:
            os.environ['RAGSYSTEM_RUNTIME_STRICT'] = self._previous_strict
        set_current_runtime_container(None)
        reset_runtime_fallback_tracking()

    def test_prefers_runtime_container_resolution(self) -> None:
        container = RuntimeContainer()
        expected = object()
        container.set_instance('demo_service', expected)
        set_current_runtime_container(container)

        created_instances: list[object] = []

        result = get_runtime_dependency(
            fallback_name='demo_service',
            fallback_factory=lambda: created_instances.append(object()),
            container_resolver=lambda current: current.get_instance('demo_service'),
        )

        self.assertIs(result, expected)
        self.assertEqual(created_instances, [])
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_strict_mode_raises_with_callsite(self) -> None:
        os.environ['RAGSYSTEM_RUNTIME_STRICT'] = '1'

        def invoke_dependency() -> object:
            return get_runtime_dependency(
                fallback_name='strict_demo_service',
                fallback_factory=object,
                container_resolver=lambda container: container,
            )

        with self.assertRaises(RuntimeError) as context:
            invoke_dependency()

        message = str(context.exception)
        self.assertIn('strict_demo_service', message)
        self.assertIn('invoke_dependency', message)
        self.assertIn('test_strict_mode_raises_with_callsite', message)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_fallback_tracking_captures_caller_and_count(self) -> None:
        state: dict[str, object | None] = {'instance': None}

        def invoke_dependency() -> object:
            return get_runtime_dependency(
                fallback_name='tracked_demo_service',
                fallback_factory=lambda: {'created': True},
                legacy_getter=lambda: state['instance'],
                legacy_setter=lambda instance: state.__setitem__('instance', instance),
                container_resolver=lambda container: container,
            )

        with self.assertLogs('runtime.dependencies', level='WARNING') as captured_logs:
            first = invoke_dependency()
            second = invoke_dependency()

        self.assertEqual(len(captured_logs.output), 1)
        self.assertIs(first, second)

        stats = get_runtime_fallback_stats()
        self.assertEqual(len(stats), 2)
        self.assertEqual({item['dependency_name'] for item in stats}, {'tracked_demo_service'})
        self.assertEqual(sum(item['count'] for item in stats), 2)
        self.assertTrue(all('invoke_dependency' in item['accessor'] for item in stats))
        self.assertTrue(
            all('test_fallback_tracking_captures_caller_and_count' in item['caller'] for item in stats)
        )

    def test_reset_runtime_fallback_tracking_clears_state(self) -> None:
        with self.assertLogs('runtime.dependencies', level='WARNING'):
            get_runtime_dependency(
                fallback_name='reset_demo_service',
                fallback_factory=object,
                container_resolver=lambda container: container,
            )

        self.assertEqual(len(get_runtime_fallback_stats()), 1)

        reset_runtime_fallback_tracking()

        self.assertEqual(get_runtime_fallback_stats(), [])


if __name__ == '__main__':
    unittest.main()

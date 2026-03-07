#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态盘点 RuntimeContainer 兼容 fallback getter。"""

from __future__ import annotations

import argparse
import ast
import json
import warnings
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional

_DEFAULT_EXCLUDES = {'__pycache__', 'docs', 'tests'}

warnings.filterwarnings('ignore', category=SyntaxWarning)


@dataclass(frozen=True)
class RuntimeDependencySite:
    path: str
    line: int
    accessor: str
    fallback_name: Optional[str]
    container_target: Optional[str]
    has_container_resolver: bool
    has_legacy_getter: bool
    has_legacy_setter: bool
    require_container: bool
    fallback_factory: Optional[str]
    fallback_kind: str


class _RuntimeDependencyVisitor(ast.NodeVisitor):
    def __init__(self, source: str, path: Path):
        self._source = source
        self._path = path
        self._scope: list[str] = []
        self.sites: list[RuntimeDependencySite] = []

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_Call(self, node: ast.Call) -> None:
        if self._is_runtime_dependency_call(node):
            keywords = {keyword.arg: keyword.value for keyword in node.keywords if keyword.arg is not None}
            fallback_factory_node = keywords.get('fallback_factory')
            site = RuntimeDependencySite(
                path=self._path.as_posix(),
                line=node.lineno,
                accessor='.'.join(self._scope) if self._scope else '<module>',
                fallback_name=self._extract_str(keywords.get('fallback_name')),
                container_target=self._extract_str(keywords.get('container_getter')),
                has_container_resolver='container_resolver' in keywords,
                has_legacy_getter='legacy_getter' in keywords,
                has_legacy_setter='legacy_setter' in keywords,
                require_container=self._is_true_literal(keywords.get('require_container')),
                fallback_factory=self._get_source(fallback_factory_node),
                fallback_kind=self._classify_fallback(keywords),
            )
            self.sites.append(site)
        self.generic_visit(node)

    @staticmethod
    def _is_runtime_dependency_call(node: ast.Call) -> bool:
        func = node.func
        if isinstance(func, ast.Name):
            return func.id == 'get_runtime_dependency'
        if isinstance(func, ast.Attribute):
            return func.attr == 'get_runtime_dependency'
        return False

    def _extract_str(self, node: Optional[ast.AST]) -> Optional[str]:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    def _is_true_literal(self, node: Optional[ast.AST]) -> bool:
        return isinstance(node, ast.Constant) and node.value is True

    def _get_source(self, node: Optional[ast.AST]) -> Optional[str]:
        if node is None:
            return None
        segment = ast.get_source_segment(self._source, node)
        if segment is not None:
            return ' '.join(segment.split())
        return None

    def _classify_fallback(self, keywords: dict[str, ast.AST]) -> str:
        has_legacy = 'legacy_getter' in keywords or 'legacy_setter' in keywords
        has_resolver = 'container_resolver' in keywords
        has_getter = 'container_getter' in keywords
        require_container = self._is_true_literal(keywords.get('require_container'))

        if require_container:
            return 'container_only'
        if has_legacy and has_resolver:
            return 'legacy_resolver'
        if has_legacy and has_getter:
            return 'legacy_getter'
        if has_legacy:
            return 'legacy_singleton'

        fallback_factory_node = keywords.get('fallback_factory')
        if isinstance(fallback_factory_node, ast.Lambda):
            if isinstance(fallback_factory_node.body, ast.Constant) and fallback_factory_node.body.value is None:
                return 'container_preferred'
        return 'factory_fallback'


def analyze_source(source: str, path: str | Path = '<memory>') -> list[RuntimeDependencySite]:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', SyntaxWarning)
        tree = ast.parse(source)
    visitor = _RuntimeDependencyVisitor(source, Path(path))
    visitor.visit(tree)
    return visitor.sites


def iter_python_files(root: Path, *, excludes: Optional[set[str]] = None) -> Iterator[Path]:
    exclude_names = _DEFAULT_EXCLUDES | (excludes or set())
    for path in sorted(root.rglob('*.py')):
        if any(part in exclude_names for part in path.parts):
            continue
        yield path


def collect_runtime_dependency_sites(root: str | Path = 'backend') -> list[RuntimeDependencySite]:
    base_path = Path(root)
    display_root = base_path.parent if base_path.is_absolute() else None
    sites: list[RuntimeDependencySite] = []
    for path in iter_python_files(base_path):
        source = path.read_text(encoding='utf-8')
        display_path = path.relative_to(display_root) if display_root is not None else path
        sites.extend(analyze_source(source, path=display_path))
    sites.sort(key=lambda item: (item.fallback_kind, item.path, item.line))
    return sites


def build_summary(sites: Iterable[RuntimeDependencySite]) -> dict[str, object]:
    items = list(sites)
    by_kind: dict[str, int] = {}
    for item in items:
        by_kind[item.fallback_kind] = by_kind.get(item.fallback_kind, 0) + 1
    return {
        'total_sites': len(items),
        'by_kind': by_kind,
    }


def find_non_container_only_sites(sites: Iterable[RuntimeDependencySite]) -> list[RuntimeDependencySite]:
    return [item for item in sites if item.fallback_kind != 'container_only']


def render_table(sites: Iterable[RuntimeDependencySite]) -> str:
    items = list(sites)
    lines = []
    summary = build_summary(items)
    lines.append('Runtime strict audit')
    lines.append(f"- total sites: {summary['total_sites']}")
    for kind, count in sorted(summary['by_kind'].items()):
        lines.append(f'- {kind}: {count}')
    lines.append('')
    for item in items:
        target = item.container_target or ('<resolver>' if item.has_container_resolver else '<none>')
        lines.append(
            f"- [{item.fallback_kind}] {item.fallback_name or '<unknown>'} -> {target} | "
            f"{item.path}:{item.line} ({item.accessor})"
        )
    return '\n'.join(lines)


def main() -> int:
    warnings.filterwarnings('ignore', category=SyntaxWarning)

    parser = argparse.ArgumentParser(description='Audit get_runtime_dependency fallback sites.')
    parser.add_argument('--root', default='backend', help='Root directory to scan (default: backend)')
    parser.add_argument('--format', choices=('table', 'json'), default='table', help='Output format')
    parser.add_argument(
        '--check-container-only',
        action='store_true',
        help='Return non-zero when any site is not container_only.',
    )
    args = parser.parse_args()

    sites = collect_runtime_dependency_sites(args.root)
    non_container_only_sites = find_non_container_only_sites(sites)
    if args.format == 'json':
        print(
            json.dumps(
                {
                    'summary': build_summary(sites),
                    'sites': [asdict(site) for site in sites],
                    'check_container_only_passed': not non_container_only_sites,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(render_table(sites))
        if args.check_container_only:
            if non_container_only_sites:
                print()
                print(f'FAILED: {len(non_container_only_sites)} non-container-only site(s) remain.')
            else:
                print()
                print('PASS: all sites are container_only.')
    if args.check_container_only and non_container_only_sites:
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

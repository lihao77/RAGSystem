# -*- coding: utf-8 -*-

import importlib
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[4]
BACKEND_DIR = ROOT_DIR / "backend-fastapi"
TOOLS_DIR = BACKEND_DIR / "tools"

REMOVED_PATHS = [
    TOOLS_DIR / "path_resolution.py",
    TOOLS_DIR / "result_references.py",
    TOOLS_DIR / "result_schema.py",
    TOOLS_DIR / "tool_definition_builder.py",
    TOOLS_DIR / "visualization_artifact_manager.py",
    TOOLS_DIR / "tool_output_type_audit.py",
    TOOLS_DIR / "observation_window_report.py",
    TOOLS_DIR / "artifacts" / "presentation_store.py",
    TOOLS_DIR / "tool_executor_modules",
]

REMOVED_MODULES = [
    "tools.path_resolution",
    "tools.result_references",
    "tools.result_schema",
    "tools.tool_definition_builder",
    "tools.visualization_artifact_manager",
    "tools.tool_output_type_audit",
    "tools.observation_window_report",
    "tools.artifacts.presentation_store",
    "tools.tool_executor_modules",
]

BANNED_SNIPPETS = [
    "from tools import",
    "tools.path_resolution",
    "tools.result_references",
    "tools.result_schema",
    "tools.tool_definition_builder",
    "tools.visualization_artifact_manager",
    "tools.tool_output_type_audit",
    "tools.observation_window_report",
    "tools.tool_executor_modules",
    "presentation_store",
]


def test_removed_legacy_tool_paths_are_absent():
    missing_failures = [str(path) for path in REMOVED_PATHS if path.exists()]
    assert missing_failures == []


@pytest.mark.parametrize("module_name", REMOVED_MODULES)
def test_removed_legacy_tool_modules_cannot_be_imported(module_name):
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module(module_name)


def test_backend_python_files_do_not_reference_legacy_tool_paths():
    offenders = []
    for path in BACKEND_DIR.rglob("*.py"):
        if "__pycache__" in path.parts or path.name == "test_tools_structure_constraints.py":
            continue
        text = path.read_text(encoding="utf-8")
        matched = [snippet for snippet in BANNED_SNIPPETS if snippet in text]
        if matched:
            offenders.append(f"{path.relative_to(BACKEND_DIR)} -> {matched}")
    assert offenders == []


def test_tools_package_init_files_are_minimal_package_markers():
    tools_init = (TOOLS_DIR / "__init__.py").read_text(encoding="utf-8")
    runtime_init = (TOOLS_DIR / "runtime" / "__init__.py").read_text(encoding="utf-8")

    assert "__all__" not in tools_init
    assert "from ." not in tools_init
    assert "__all__" not in runtime_init
    assert "from .executor import" not in runtime_init
    assert "from .registration import" not in runtime_init

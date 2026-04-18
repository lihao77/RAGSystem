# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

project_root = Path.cwd().resolve().parent
backend_root = project_root / 'backend-fastapi'
frontend_dist = project_root / 'frontend-client' / 'dist'

if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

explicit_local_hiddenimports = [
    'tools.local.agent_tools',
    'tools.local.bash_tool',
    'tools.local.builtin_tools',
    'tools.local.code_sandbox',
    'tools.local.document_tools',
    'tools.local.glob_tool',
    'tools.local.grep_tool',
    'tools.local.memory_tools',
    'tools.local.skill_tools',
    'tools.local.task_tools',
    'tools.local.todo_tools',
    'tools.local.web_fetch_tool',
]

hiddenimports = [
    'uvicorn',
    'fastapi',
    'yaml',
    'dotenv',
    'multipart',
    *explicit_local_hiddenimports,
    *collect_submodules('tools.local'),
    *collect_submodules('mcp.client'),
    *collect_submodules('mcp.shared'),
    *collect_submodules('mcp.types'),
]

excluded_patterns = [
    '.venv',
    '__pycache__',
    '.pytest_cache',
]


def _should_skip(path: Path) -> bool:
    parts = set(path.parts)
    return any(pattern in parts for pattern in excluded_patterns)


extra_datas = list(copy_metadata('mcp'))
for relative in ['config', 'agents', 'hooks']:
    source = backend_root / relative
    if not source.exists():
        continue
    if source.is_file():
        extra_datas.append((str(source), relative))
        continue
    for child in source.rglob('*'):
        if not child.is_file() or _should_skip(child):
            continue
        destination = child.relative_to(backend_root).parent
        extra_datas.append((str(child), str(destination)))

if frontend_dist.exists():
    for child in frontend_dist.rglob('*'):
        if child.is_file():
            destination = Path('frontend-dist') / child.relative_to(frontend_dist).parent
            extra_datas.append((str(child), str(destination)))

block_cipher = None


a = Analysis(
    ['desktop_entry.py'],
    pathex=[str(backend_root)],
    binaries=[],
    datas=extra_datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='RAGSystemBackend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='RAGSystemBackend',
)

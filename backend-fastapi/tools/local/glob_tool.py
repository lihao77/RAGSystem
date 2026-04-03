"""
Glob Tool - Fast file pattern matching tool
Migrated from Claude Code's GlobTool.ts
"""

import os
import platform
import glob as python_glob
import time
from pathlib import Path
from typing import List, Dict, Any, Optional

from tools.decorators import tool
from tools.contracts.permissions import RiskLevel


def extract_glob_base_directory(pattern: str) -> tuple[str, str]:
    """
    Extracts the static base directory from a glob pattern.
    Returns (base_dir, relative_pattern).
    
    Example:
        "src/**/*.py" -> ("src", "**/*.py")
        "**/*.js" -> ("", "**/*.js")
        "/absolute/path/**/*.txt" -> ("/absolute/path", "**/*.txt")
    """
    # Find first glob special character: *, ?, [, {
    glob_chars = set('*?[{')
    
    first_glob_idx = None
    for i, ch in enumerate(pattern):
        if ch in glob_chars:
            first_glob_idx = i
            break
    
    if first_glob_idx is None:
        # No glob characters - this is a literal path
        path_obj = Path(pattern)
        parent = str(path_obj.parent) if str(path_obj.parent) != '.' else ''
        return parent, path_obj.name
    
    # Get everything before first glob character
    static_prefix = pattern[:first_glob_idx]
    
    # Find last path separator in static prefix
    last_sep_idx = max(
        static_prefix.rfind('/'),
        static_prefix.rfind(os.sep)
    )
    
    if last_sep_idx == -1:
        # No path separator before glob - pattern is relative to cwd
        return "", pattern
    
    base_dir = static_prefix[:last_sep_idx]
    relative_pattern = pattern[last_sep_idx + 1:]
    
    # Handle root directory patterns
    if base_dir == "" and last_sep_idx == 0:
        base_dir = "/"
    
    return base_dir, relative_pattern


def glob_search(
    pattern: str,
    search_dir: str,
    limit: int = 100,
    offset: int = 0,
    recursive: bool = True
) -> tuple[List[str], bool]:
    """
    Perform glob search with pagination.
    
    Args:
        pattern: Glob pattern (e.g., "**/*.py", "*.js")
        search_dir: Directory to search in
        limit: Maximum number of results
        offset: Skip first N results
        recursive: Enable recursive search (** patterns)
    
    Returns:
        (files, truncated) - List of file paths and whether results were truncated
    """
    # Expand to absolute path
    search_dir = os.path.abspath(os.path.expanduser(search_dir))
    
    # Security: Block Windows UNC paths to prevent NTLM credential leaks
    if platform.system() == "Windows":
        if search_dir.startswith("\\\\") or (os.path.isabs(pattern) and pattern.startswith("\\\\")):
            raise ValueError("UNC paths (\\\\server\\share) are not allowed for security reasons")
    
    # Build full pattern
    if os.path.isabs(pattern):
        # Pattern is absolute
        base_dir, rel_pattern = extract_glob_base_directory(pattern)
        search_dir = base_dir if base_dir else search_dir
        pattern = rel_pattern
    
    full_pattern = os.path.join(search_dir, pattern)
    
    # Execute glob
    try:
        all_files = sorted(
            python_glob.glob(full_pattern, recursive=recursive),
            key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0,
            reverse=True  # Newest first
        )
    except (OSError, PermissionError) as e:
        # Permission errors or invalid paths
        return [], False
    
    # Filter to only files (not directories)
    files = [f for f in all_files if os.path.isfile(f)]
    
    # Apply pagination
    total_count = len(files)
    paginated_files = files[offset:offset + limit]
    truncated = total_count > (offset + limit)
    
    return paginated_files, truncated


@tool(
    name="glob",
    description=(
        "Fast file pattern matching using glob patterns. "
        "Supports wildcards like '*.py', '**/*.js' (recursive), 'src/**/*.ts'. "
        "Returns matching file paths sorted by modification time (newest first). "
        "Use when you need to find files by name patterns."
    ),
    parameters={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": (
                    "The glob pattern to match files against. "
                    "Examples: '*.py', '**/*.js', 'src/**/*.{ts,tsx}', 'test_*.py'"
                )
            },
            "path": {
                "type": "string",
                "description": (
                    "The directory to search in. Defaults to current working directory if not specified. "
                    "IMPORTANT: Omit this field to use the default directory - "
                    "DO NOT enter 'undefined' or 'null'."
                )
            }
        },
        "required": ["pattern"]
    },
    risk_level=RiskLevel.LOW,
    timeout_seconds=60,
    allowed_callers=["direct", "code_execution"],
    usage_contract=[
        "Read-only operation",
        "Limited to 100 files by default to prevent token overflow",
        "Respects file system permissions",
        "Results sorted by modification time (newest first)"
    ],
    examples=[
        {
            "description": "Find all Python files in current directory (non-recursive)",
            "input": {"pattern": "*.py"}
        },
        {
            "description": "Find all JavaScript files recursively",
            "input": {"pattern": "**/*.js"}
        },
        {
            "description": "Find TypeScript files in src directory",
            "input": {"pattern": "**/*.ts", "path": "src"}
        },
        {
            "description": "Find test files with multiple extensions",
            "input": {"pattern": "test_*.{py,js}"}
        }
    ]
)
def glob_handler(
    pattern: str,
    path: Optional[str] = None,
    **kwargs
) -> Dict[str, Any]:
    """
    Execute glob file search.
    
    Args:
        pattern: Glob pattern to match
        path: Optional search directory (defaults to cwd)
        **kwargs: Context parameters (session_id, cancel_event, etc.)
    
    Returns:
        {
            "filenames": List[str],      # Matched file paths
            "numFiles": int,              # Number of files found
            "truncated": bool,            # Whether results were truncated
            "durationMs": int             # Execution time in milliseconds
        }
    """
    start_time = time.time()
    
    # Determine search directory
    search_dir = path if path else os.getcwd()
    
    # Validate directory exists
    if not os.path.isdir(search_dir):
        # Try to provide helpful error message
        cwd = os.getcwd()
        error_msg = f"Directory does not exist: {path}. Current working directory is {cwd}."
        
        # Check if path might be relative to cwd
        if path and not os.path.isabs(path):
            potential_path = os.path.join(cwd, path)
            if os.path.isdir(potential_path):
                error_msg += f" Did you mean '{path}' relative to cwd?"
        
        return {
            "error": error_msg,
            "filenames": [],
            "numFiles": 0,
            "truncated": False,
            "durationMs": 0
        }
    
    # Check if path is a file (not a directory)
    if os.path.exists(search_dir) and not os.path.isdir(search_dir):
        return {
            "error": f"Path is not a directory: {path}",
            "filenames": [],
            "numFiles": 0,
            "truncated": False,
            "durationMs": 0
        }
    
    # Execute glob search
    try:
        files, truncated = glob_search(
            pattern=pattern,
            search_dir=search_dir,
            limit=100,  # Default limit from Claude Code
            offset=0,
            recursive=True
        )
        
        # 转换为相对路径（使用 Path 对象统一处理分隔符，避免 Windows 下字符串长度比较失准）
        cwd = Path(os.getcwd())
        relative_files = []
        for f in files:
            try:
                rel_path = Path(f).relative_to(cwd)
                # relative_to 成功即表示路径在 cwd 内，无 '..' 跳出
                relative_files.append(str(rel_path))
            except ValueError:
                # 不在 cwd 下（不同驱动器或路径跳出），保留绝对路径
                relative_files.append(f)
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        return {
            "filenames": relative_files,
            "numFiles": len(relative_files),
            "truncated": truncated,
            "durationMs": duration_ms
        }
        
    except Exception as e:
        return {
            "error": f"Glob search failed: {str(e)}",
            "filenames": [],
            "numFiles": 0,
            "truncated": False,
            "durationMs": int((time.time() - start_time) * 1000)
        }


# Tool metadata for discovery
__all__ = ['glob_handler', 'glob_search', 'extract_glob_base_directory']

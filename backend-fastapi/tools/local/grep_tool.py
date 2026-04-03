"""
Grep Tool - High-performance code search using ripgrep
Migrated from Claude Code's GrepTool.ts
"""

import os
import subprocess
import time
import re
from pathlib import Path
from typing import List, Dict, Any, Optional, Literal
from enum import Enum

from tools.decorators import tool
from tools.contracts.permissions import RiskLevel


class OutputMode(str, Enum):
    """Grep output modes"""
    CONTENT = "content"              # Show matching lines with context
    FILES_WITH_MATCHES = "files_with_matches"  # Show only file paths
    COUNT = "count"                  # Show match counts per file


# Cached ripgrep path to avoid repeated subprocess calls
_rg_path: Optional[str] = None


def find_ripgrep() -> Optional[str]:
    """Find ripgrep executable (rg) - cached result"""
    global _rg_path
    if _rg_path is None:
        try:
            result = subprocess.run(
                ['which', 'rg'],
                capture_output=True,
                text=True,
                timeout=2
            )
            if result.returncode == 0:
                _rg_path = result.stdout.strip()
        except Exception:
            pass
        
        # Try direct command if which failed
        if _rg_path is None:
            try:
                result = subprocess.run(
                    ['rg', '--version'],
                    capture_output=True,
                    text=True,
                    timeout=2
                )
                if result.returncode == 0:
                    _rg_path = 'rg'
            except Exception:
                pass
    
    return _rg_path


def execute_ripgrep(
    pattern: str,
    search_path: str,
    output_mode: OutputMode = OutputMode.FILES_WITH_MATCHES,
    glob_pattern: Optional[str] = None,
    file_type: Optional[str] = None,
    case_insensitive: bool = False,
    context_before: Optional[int] = None,
    context_after: Optional[int] = None,
    context: Optional[int] = None,
    show_line_numbers: bool = True,
    head_limit: Optional[int] = None,
    offset: int = 0,
    multiline: bool = False,
    timeout: int = 30
) -> Dict[str, Any]:
    """
    Execute ripgrep search with various options.
    
    Returns:
        {
            "output": str,           # Raw output
            "matches": List[str],    # Parsed matches (lines or files)
            "count": int,            # Number of matches
            "truncated": bool,       # Whether results were truncated
            "durationMs": int        # Execution time
        }
    """
    start_time = time.time()
    
    # Find ripgrep
    rg_cmd = find_ripgrep()
    if not rg_cmd:
        return {
            "error": "ripgrep (rg) not found. Please install: apt-get install ripgrep or brew install ripgrep",
            "output": "",
            "matches": [],
            "count": 0,
            "truncated": False,
            "durationMs": 0
        }
    
    # Build ripgrep command
    cmd = [rg_cmd]
    
    # Output mode
    if output_mode == OutputMode.FILES_WITH_MATCHES:
        cmd.append('--files-with-matches')
    elif output_mode == OutputMode.COUNT:
        cmd.append('--count')
    # CONTENT mode uses default output
    
    # Context (mutually exclusive with -B/-A)
    if context is not None:
        cmd.extend(['-C', str(context)])
    else:
        if context_before is not None:
            cmd.extend(['-B', str(context_before)])
        if context_after is not None:
            cmd.extend(['-A', str(context_after)])
    
    # Line numbers (only for content mode)
    if output_mode == OutputMode.CONTENT and show_line_numbers:
        cmd.append('-n')
    
    # Case sensitivity
    if case_insensitive:
        cmd.append('-i')
    
    # Multiline mode
    if multiline:
        cmd.extend(['-U', '--multiline-dotall'])
    
    # File type filter
    if file_type:
        cmd.extend(['--type', file_type])
    
    # Glob pattern filter
    if glob_pattern:
        cmd.extend(['--glob', glob_pattern])
    
    # Exclude common directories
    for exclude in ['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.pytest_cache']:
        cmd.extend(['--glob', f'!{exclude}'])
    
    # Pattern and path
    cmd.append(pattern)
    cmd.append(search_path)
    
    # Execute command
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=os.getcwd()
        )
        
        output = result.stdout
        stderr = result.stderr
        
        # ripgrep exit codes:
        # 0 - matches found
        # 1 - no matches
        # 2 - error
        if result.returncode == 2:
            return {
                "error": f"ripgrep error: {stderr}",
                "output": output,
                "matches": [],
                "count": 0,
                "truncated": False,
                "durationMs": int((time.time() - start_time) * 1000)
            }
        
        # Parse output
        matches = []
        if output:
            lines = output.strip().split('\n')
            
            # Apply offset and limit
            if offset > 0:
                lines = lines[offset:]
            
            truncated = False
            if head_limit and len(lines) > head_limit:
                lines = lines[:head_limit]
                truncated = True
            
            matches = lines
        else:
            truncated = False
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        return {
            "output": output,
            "matches": matches,
            "count": len(matches),
            "truncated": truncated,
            "durationMs": duration_ms
        }
        
    except subprocess.TimeoutExpired:
        return {
            "error": f"Search timed out after {timeout}s",
            "output": "",
            "matches": [],
            "count": 0,
            "truncated": False,
            "durationMs": int((time.time() - start_time) * 1000)
        }
    except Exception as e:
        return {
            "error": f"Search failed: {str(e)}",
            "output": "",
            "matches": [],
            "count": 0,
            "truncated": False,
            "durationMs": int((time.time() - start_time) * 1000)
        }


@tool(
    name="grep",
    description=(
        "Fast and precise code search using ripgrep. "
        "Search for patterns in file contents with various output modes and filtering options. "
        "Built on ripgrep for high performance."
    ),
    parameters={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "The regular expression pattern to search for in file contents"
            },
            "path": {
                "type": "string",
                "description": (
                    "File or directory to search in. Defaults to current working directory if not specified."
                )
            },
            "glob": {
                "type": "string",
                "description": "Glob pattern to filter files (e.g., '*.js', '*.{ts,tsx}')"
            },
            "output_mode": {
                "type": "string",
                "enum": ["content", "files_with_matches", "count"],
                "description": (
                    "Output mode: 'content' shows matching lines (supports context and line numbers), "
                    "'files_with_matches' shows only file paths, 'count' shows match counts per file. "
                    "Defaults to 'files_with_matches'."
                )
            },
            "context_before": {
                "type": "integer",
                "description": "Number of lines to show before each match (requires output_mode: 'content')"
            },
            "context_after": {
                "type": "integer",
                "description": "Number of lines to show after each match (requires output_mode: 'content')"
            },
            "context": {
                "type": "integer",
                "description": "Number of lines to show before and after each match (requires output_mode: 'content')"
            },
            "show_line_numbers": {
                "type": "boolean",
                "description": "Show line numbers in output (requires output_mode: 'content'). Defaults to true."
            },
            "case_insensitive": {
                "type": "boolean",
                "description": "Case insensitive search"
            },
            "file_type": {
                "type": "string",
                "description": (
                    "File type to search (e.g., 'js', 'py', 'rust', 'go', 'java'). "
                    "More efficient than glob for standard file types."
                )
            },
            "head_limit": {
                "type": "integer",
                "description": (
                    "Limit output to first N results. Defaults to 250. "
                    "Works across all output modes. Pass 0 for unlimited (use sparingly)."
                )
            },
            "offset": {
                "type": "integer",
                "description": "Skip first N results before applying head_limit. Defaults to 0."
            },
            "multiline": {
                "type": "boolean",
                "description": "Enable multiline mode where patterns can span lines. Default: false."
            }
        },
        "required": ["pattern"]
    },
    risk_level=RiskLevel.LOW,
    timeout_seconds=60,
    allowed_callers=["direct"],
    usage_contract=[
        "Read-only operation",
        "Automatically excludes .git, .svn, .hg, node_modules, __pycache__",
        "Limited to 250 results by default to prevent token overflow",
        "Requires ripgrep (rg) to be installed on the system"
    ],
    examples=[
        {
            "description": "Find all files containing 'TODO'",
            "input": {"pattern": "TODO"}
        },
        {
            "description": "Search for function definitions in Python files",
            "input": {
                "pattern": "def \\w+\\(",
                "file_type": "py",
                "output_mode": "content"
            }
        },
        {
            "description": "Case-insensitive search with context",
            "input": {
                "pattern": "error",
                "case_insensitive": True,
                "context": 2,
                "output_mode": "content"
            }
        },
        {
            "description": "Search in specific directory with glob filter",
            "input": {
                "pattern": "import.*React",
                "path": "src",
                "glob": "*.{ts,tsx}"
            }
        },
        {
            "description": "Find function definitions with line numbers",
            "input": {
                "pattern": "def \\w+\\(",
                "file_type": "py",
                "output_mode": "content",
                "show_line_numbers": True
            }
        }
    ]
)
def grep_handler(
    pattern: str,
    path: Optional[str] = None,
    glob: Optional[str] = None,
    output_mode: str = "files_with_matches",
    file_type: Optional[str] = None,
    head_limit: Optional[int] = 250,
    offset: int = 0,
    multiline: bool = False,
    context_before: Optional[int] = None,
    context_after: Optional[int] = None,
    context: Optional[int] = None,
    show_line_numbers: bool = True,
    case_insensitive: bool = False
) -> Dict[str, Any]:
    """
    Execute ripgrep search.
    
    Args:
        pattern: Regular expression pattern to search
        path: Optional search path (defaults to cwd)
        glob: Optional glob pattern filter
        output_mode: Output format (content/files_with_matches/count)
        file_type: File type filter (js/py/rust/go/java/etc)
        head_limit: Maximum number of results (default 250)
        offset: Skip first N results
        multiline: Enable multiline mode
        context_before: Lines of context before match (-B flag)
        context_after: Lines of context after match (-A flag)
        context: Lines of context before and after match (-C flag)
        show_line_numbers: Show line numbers in output (-n flag)
        case_insensitive: Case insensitive search (-i flag)
    
    Returns:
        Search results with matches, count, and metadata
    """
    
    # Determine search path
    search_path = path if path else os.getcwd()
    
    # Validate path exists
    if not os.path.exists(search_path):
        cwd = os.getcwd()
        return {
            "error": f"Path does not exist: {path}. Current working directory is {cwd}.",
            "matches": [],
            "count": 0,
            "truncated": False,
            "durationMs": 0
        }
    
    # Parse output mode
    try:
        mode = OutputMode(output_mode)
    except ValueError:
        mode = OutputMode.FILES_WITH_MATCHES
    
    # Execute search
    result = execute_ripgrep(
        pattern=pattern,
        search_path=search_path,
        output_mode=mode,
        glob_pattern=glob,
        file_type=file_type,
        case_insensitive=case_insensitive,
        context_before=context_before,
        context_after=context_after,
        context=context,
        show_line_numbers=show_line_numbers,
        head_limit=head_limit if head_limit != 0 else None,
        offset=offset,
        multiline=multiline
    )
    
    return result


# Tool metadata for discovery
__all__ = ['grep_handler', 'execute_ripgrep', 'find_ripgrep']

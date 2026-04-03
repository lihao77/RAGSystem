"""
Web Fetch Tool - Fetch and convert web pages to Markdown
Migrated from Claude Code's WebFetchTool
"""

import requests
from typing import Dict, Any, Optional
from html import unescape
import re

from tools.decorators import tool
from tools.contracts.permissions import RiskLevel


def html_to_markdown_simple(html: str) -> str:
    """
    Simple HTML to Markdown conversion.
    For production, consider using html2text library.
    """
    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.ignore_images = False
        h.ignore_emphasis = False
        h.body_width = 0  # Don't wrap lines
        return h.handle(html)
    except ImportError:
        # Fallback: simple tag stripping
        text = html
        # Remove scripts and styles
        text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
        # Remove HTML tags
        text = re.sub(r'<[^>]+>', '', text)
        # Unescape HTML entities
        text = unescape(text)
        # Clean up whitespace
        text = re.sub(r'\n\s*\n', '\n\n', text)
        return text.strip()


@tool(
    name="web_fetch",
    description=(
        "Fetch content from a URL and return it as Markdown or raw HTML. "
        "Supports pagination for large pages. "
        "Use this to retrieve and parse web content."
    ),
    parameters={
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to fetch"
            },
            "raw": {
                "type": "boolean",
                "description": (
                    "If true, returns raw HTML. If false (default), converts to simplified Markdown. "
                    "Defaults to false."
                )
            },
            "max_length": {
                "type": "integer",
                "description": (
                    "Maximum number of characters to return. "
                    "Defaults to 5000, maximum is 20000. Use for token management."
                )
            },
            "start_index": {
                "type": "integer",
                "description": (
                    "Start index for pagination. Use this to continue reading if content was truncated. "
                    "Defaults to 0."
                )
            }
        },
        "required": ["url"]
    },
    risk_level=RiskLevel.LOW,
    timeout_seconds=30,
    allowed_callers=["direct"],
    usage_contract=[
        "Read-only operation",
        "Respects robots.txt (in production)",
        "Sets proper User-Agent",
        "Supports pagination for large pages",
        "Timeout after 30 seconds"
    ],
    examples=[
        {
            "description": "Fetch page as Markdown",
            "input": {"url": "https://example.com"}
        },
        {
            "description": "Fetch raw HTML",
            "input": {"url": "https://example.com", "raw": True}
        },
        {
            "description": "Fetch with length limit",
            "input": {
                "url": "https://example.com",
                "max_length": 10000
            }
        },
        {
            "description": "Continue reading from offset",
            "input": {
                "url": "https://example.com",
                "start_index": 10000,
                "max_length": 10000
            }
        }
    ]
)
def web_fetch_handler(
    url: str,
    raw: bool = False,
    max_length: int = 5000,
    start_index: int = 0,
    **kwargs
) -> Dict[str, Any]:
    """
    Fetch web content and optionally convert to Markdown.
    
    Args:
        url: URL to fetch
        raw: Return raw HTML (True) or Markdown (False)
        max_length: Maximum characters to return (5000-20000)
        start_index: Pagination offset
        **kwargs: Context parameters
    
    Returns:
        {
            "content": str,        # Page content
            "truncated": bool,     # Whether content was truncated
            "total_length": int,   # Total content length
            "url": str             # Fetched URL
        }
    """
    # Validate max_length
    max_length = min(max_length, 20000)
    max_length = max(max_length, 100)
    
    # Set User-Agent
    headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; RAGSystem/1.0; +https://github.com/ragsystem)'
    }
    
    try:
        # Fetch URL
        response = requests.get(
            url,
            headers=headers,
            timeout=30,
            allow_redirects=True
        )
        response.raise_for_status()
        
        # Get content
        if raw:
            content = response.text
        else:
            # Convert to Markdown
            content = html_to_markdown_simple(response.text)
        
        # Apply pagination
        total_length = len(content)
        end_index = start_index + max_length
        
        paginated_content = content[start_index:end_index]
        truncated = end_index < total_length
        
        return {
            "content": paginated_content,
            "truncated": truncated,
            "total_length": total_length,
            "url": response.url,  # Final URL after redirects
            "start_index": start_index,
            "end_index": min(end_index, total_length)
        }
        
    except requests.Timeout:
        return {
            "error": f"Request timed out after 30 seconds: {url}",
            "content": "",
            "truncated": False,
            "total_length": 0,
            "url": url
        }
    except requests.RequestException as e:
        return {
            "error": f"Failed to fetch URL: {str(e)}",
            "content": "",
            "truncated": False,
            "total_length": 0,
            "url": url
        }
    except Exception as e:
        return {
            "error": f"Unexpected error: {str(e)}",
            "content": "",
            "truncated": False,
            "total_length": 0,
            "url": url
        }


__all__ = ['web_fetch_handler', 'html_to_markdown_simple']

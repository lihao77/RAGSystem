# -*- coding: utf-8 -*-
"""MCP Registry search and install helpers."""

from __future__ import annotations

import copy
import os
import re
from typing import Any, Dict, Iterable, List, Optional

import requests

from .config import MCPServerConfig


REGISTRY_BASE_URL = os.getenv("MCP_REGISTRY_BASE_URL", "https://registry.modelcontextprotocol.io")
REGISTRY_TIMEOUT = int(os.getenv("MCP_REGISTRY_TIMEOUT", "15"))
REGISTRY_META_KEY = "io.modelcontextprotocol.registry/official"
MAX_SEARCH_LIMIT = 20
MAX_SEARCH_PAGES = 5

SUPPORTED_PACKAGE_RUNTIMES = {
    "npm": "npx",
    "pypi": "uvx",
    "oci": "docker",
    "nuget": "dnx",
}


class MCPRegistryError(RuntimeError):
    """Raised when MCP Registry operations fail."""


def search_registry_servers(
    search: str = "",
    limit: int = 8,
    cursor: Optional[str] = None,
    latest_only: bool = True,
) -> Dict[str, Any]:
    """Search installable servers from the official MCP Registry."""
    search_term = (search or "").strip()
    requested_limit = max(1, min(int(limit or 8), MAX_SEARCH_LIMIT))
    next_cursor = cursor or None
    seen: set[tuple[str, str]] = set()
    items: List[Dict[str, Any]] = []
    pages = 0

    while len(items) < requested_limit and pages < MAX_SEARCH_PAGES:
        payload = _fetch_registry_page(search_term, requested_limit, next_cursor)
        entries = payload.get("servers") or []
        metadata = payload.get("metadata") or {}
        next_cursor = metadata.get("nextCursor")
        pages += 1

        for entry in entries:
            normalized = _normalize_registry_entry(entry)
            key = (normalized["name"], normalized["version"])
            if key in seen:
                continue
            seen.add(key)

            if latest_only and not normalized.get("latest"):
                continue

            items.append(normalized)
            if len(items) >= requested_limit:
                break

        if not next_cursor or not latest_only:
            break

    return {
        "items": items,
        "count": len(items),
        "next_cursor": next_cursor,
        "search": search_term,
        "latest_only": latest_only,
    }


def build_server_config_from_registry_install(install_option: Dict[str, Any], payload: Dict[str, Any]) -> MCPServerConfig:
    """Build a local MCP server config from a normalized registry install option."""
    if not isinstance(install_option, dict):
        raise ValueError("`install_option` is required")

    option_id = (install_option.get("id") or "").strip()
    if not option_id:
        raise ValueError("Registry install option is missing `id`")
    if not install_option.get("supported", False):
        reason = install_option.get("unsupported_reason") or "Unsupported install option"
        raise ValueError(reason)

    kind = install_option.get("kind")
    input_values = payload.get("input_values") or {}

    server_name = _clean_server_name(payload.get("server_name") or install_option.get("default_server_name"))
    if not server_name:
        raise ValueError("`server_name` is required")

    display_name = (payload.get("display_name") or install_option.get("default_display_name") or server_name).strip()
    timeout = int(payload.get("timeout") or install_option.get("default_timeout") or 30)
    risk_level = (payload.get("risk_level") or install_option.get("default_risk_level") or "medium").strip() or "medium"
    requires_approval = bool(payload.get("requires_approval", install_option.get("default_requires_approval", False)))

    common = {
        "name": server_name,
        "display_name": display_name,
        "enabled": bool(payload.get("enabled", True)),
        "auto_connect": bool(payload.get("auto_connect", True)),
        "timeout": timeout,
        "risk_level": risk_level,
        "requires_approval": requires_approval,
    }

    if kind == "package":
        package = install_option.get("recipe") or {}
        transport = ((package.get("transport") or {}).get("type") or "stdio").strip()
        if transport != "stdio":
            raise ValueError(f"暂不支持从 Registry 一键安装 transport={transport} 的本地包")

        command, args = _resolve_package_runtime(package, input_values)
        env = _resolve_key_value_items(package.get("environmentVariables") or [], input_values)

        return MCPServerConfig(
            transport="stdio",
            command=command,
            args=args,
            env=env,
            headers={},
            url=None,
            **common,
        )

    if kind == "remote":
        remote = install_option.get("recipe") or {}
        transport = _normalize_transport_type(remote.get("type") or "streamable-http")
        if transport not in {"sse", "streamable_http"}:
            raise ValueError(f"不支持的远程 transport: {transport}")

        url = _resolve_template_string(remote.get("url") or "", input_values, remote.get("variables") or {})
        if not url:
            raise ValueError("Registry 远程服务缺少 URL")
        headers = _resolve_key_value_items(remote.get("headers") or [], input_values)

        return MCPServerConfig(
            transport=transport,
            command=None,
            args=[],
            env={},
            headers=headers,
            url=url,
            **common,
        )

    raise ValueError(f"未知的安装方式: {kind}")


def _fetch_registry_page(search: str, limit: int, cursor: Optional[str]) -> Dict[str, Any]:
    params: Dict[str, Any] = {"limit": limit}
    if search:
        params["search"] = search
    if cursor:
        params["cursor"] = cursor

    url = f"{REGISTRY_BASE_URL.rstrip('/')}/v0/servers"
    try:
        response = requests.get(url, params=params, timeout=REGISTRY_TIMEOUT)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise MCPRegistryError(f"Failed to query MCP Registry: {exc}") from exc

    try:
        return response.json()
    except ValueError as exc:
        raise MCPRegistryError("MCP Registry returned invalid JSON") from exc


def _normalize_registry_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    server = entry.get("server") or {}
    meta = ((entry.get("_meta") or {}).get(REGISTRY_META_KEY) or {})
    display_name = (server.get("title") or server.get("name") or "").strip()
    install_options: List[Dict[str, Any]] = []

    for index, package in enumerate(server.get("packages") or []):
        install_options.append(_normalize_package_option(server, package, index))

    for index, remote in enumerate(server.get("remotes") or []):
        install_options.append(_normalize_remote_option(server, remote, index))

    preferred = next((option["id"] for option in install_options if option.get("supported")), None)
    supported_methods = [option for option in install_options if option.get("supported")]

    return {
        "name": server.get("name") or "",
        "display_name": display_name,
        "description": server.get("description") or "",
        "version": server.get("version") or "",
        "latest": bool(meta.get("isLatest", False)),
        "published_at": meta.get("publishedAt"),
        "updated_at": meta.get("updatedAt"),
        "website_url": server.get("websiteUrl"),
        "repository_url": ((server.get("repository") or {}).get("url")),
        "installable": bool(supported_methods),
        "install_options": install_options,
        "preferred_option_id": preferred,
        "default_server_name": _clean_server_name(server.get("name") or display_name),
        "default_display_name": display_name,
    }


def _normalize_package_option(server: Dict[str, Any], package: Dict[str, Any], index: int) -> Dict[str, Any]:
    recipe = copy.deepcopy(package)
    _annotate_recipe(recipe, prefix=f"package.{index}")

    transport_type = ((recipe.get("transport") or {}).get("type") or "stdio").strip()
    registry_type = (recipe.get("registryType") or "custom").strip() or "custom"
    runtime_hint = _infer_runtime_hint(recipe)
    supported = transport_type == "stdio" and bool(runtime_hint)
    unsupported_reason = None

    if transport_type != "stdio":
        unsupported_reason = f"当前系统仅支持从 Registry 一键安装 stdio 本地包，暂不支持 {transport_type} 包"
    elif not runtime_hint:
        unsupported_reason = f"当前系统暂不支持 registryType={registry_type} 的自动启动命令"

    command_preview = None
    if supported:
        try:
            command_preview = _build_package_preview(recipe)
        except Exception:
            command_preview = None

    default_risk_level = "high" if runtime_hint == "docker" else "medium"
    default_requires_approval = runtime_hint == "docker"

    return {
        "id": f"pkg-{index}",
        "kind": "package",
        "label": f"{registry_type} · {transport_type}",
        "transport": _normalize_transport_type(transport_type),
        "runtime_hint": runtime_hint,
        "supported": supported,
        "unsupported_reason": unsupported_reason,
        "command_preview": command_preview,
        "url_preview": None,
        "form_fields": _build_form_fields(recipe),
        "recipe": recipe,
        "default_server_name": _clean_server_name(server.get("name") or ""),
        "default_display_name": (server.get("title") or server.get("name") or "").strip(),
        "default_timeout": 60 if runtime_hint == "docker" else 30,
        "default_risk_level": default_risk_level,
        "default_requires_approval": default_requires_approval,
    }


def _normalize_remote_option(server: Dict[str, Any], remote: Dict[str, Any], index: int) -> Dict[str, Any]:
    recipe = copy.deepcopy(remote)
    _annotate_recipe(recipe, prefix=f"remote.{index}")

    transport = _normalize_transport_type(recipe.get("type") or "streamable-http")
    supported = transport in {"sse", "streamable_http"}
    unsupported_reason = None if supported else f"当前系统暂不支持 transport={transport} 的远程服务"

    return {
        "id": f"remote-{index}",
        "kind": "remote",
        "label": f"remote · {transport}",
        "transport": transport,
        "runtime_hint": None,
        "supported": supported,
        "unsupported_reason": unsupported_reason,
        "command_preview": None,
        "url_preview": _build_remote_preview(recipe),
        "form_fields": _build_form_fields(recipe),
        "recipe": recipe,
        "default_server_name": _clean_server_name(server.get("name") or ""),
        "default_display_name": (server.get("title") or server.get("name") or "").strip(),
        "default_timeout": 60,
        "default_risk_level": "medium",
        "default_requires_approval": False,
    }


def _annotate_recipe(recipe: Dict[str, Any], prefix: str) -> None:
    for index, item in enumerate(recipe.get("environmentVariables") or []):
        _annotate_input(item, f"{prefix}.env.{index}")
    for index, item in enumerate(recipe.get("runtimeArguments") or []):
        _annotate_input(item, f"{prefix}.runtime.{index}")
    for index, item in enumerate(recipe.get("packageArguments") or []):
        _annotate_input(item, f"{prefix}.package.{index}")
    for index, item in enumerate(recipe.get("headers") or []):
        _annotate_input(item, f"{prefix}.header.{index}")

    variables = recipe.get("variables") or {}
    if isinstance(variables, dict):
        for name, variable in variables.items():
            _annotate_input(variable, f"{prefix}.var.{name}")

    transport = recipe.get("transport") or {}
    if isinstance(transport, dict):
        for index, item in enumerate(transport.get("headers") or []):
            _annotate_input(item, f"{prefix}.transport_header.{index}")
        variables = transport.get("variables") or {}
        if isinstance(variables, dict):
            for name, variable in variables.items():
                _annotate_input(variable, f"{prefix}.transport_var.{name}")


def _annotate_input(item: Dict[str, Any], field_key: str) -> None:
    if not isinstance(item, dict):
        return
    item["client_field_key"] = field_key
    variables = item.get("variables") or {}
    if isinstance(variables, dict):
        for name, variable in variables.items():
            _annotate_input(variable, f"{field_key}.var.{name}")


def _build_form_fields(recipe: Dict[str, Any]) -> List[Dict[str, Any]]:
    fields: List[Dict[str, Any]] = []
    fields.extend(_collect_fields(recipe.get("environmentVariables") or [], source="env"))
    fields.extend(_collect_fields(recipe.get("runtimeArguments") or [], source="runtime_argument"))
    fields.extend(_collect_fields(recipe.get("packageArguments") or [], source="package_argument"))
    fields.extend(_collect_fields(recipe.get("headers") or [], source="header"))

    variables = recipe.get("variables") or {}
    if isinstance(variables, dict):
        for name, variable in variables.items():
            fields.extend(_collect_single_field(variable, source="variable", fallback_label=name))

    transport = recipe.get("transport") or {}
    if isinstance(transport, dict):
        fields.extend(_collect_fields(transport.get("headers") or [], source="header"))
        variables = transport.get("variables") or {}
        if isinstance(variables, dict):
            for name, variable in variables.items():
                fields.extend(_collect_single_field(variable, source="variable", fallback_label=name))

    return fields


def _collect_fields(items: Iterable[Dict[str, Any]], source: str) -> List[Dict[str, Any]]:
    fields: List[Dict[str, Any]] = []
    for item in items:
        fields.extend(_collect_single_field(item, source=source))
    return fields


def _collect_single_field(item: Dict[str, Any], source: str, fallback_label: Optional[str] = None) -> List[Dict[str, Any]]:
    if not isinstance(item, dict):
        return []

    fields: List[Dict[str, Any]] = []
    if _field_needs_user_input(item):
        field_key = item.get("client_field_key")
        if field_key:
            fields.append({
                "key": field_key,
                "label": _field_label(item, fallback_label),
                "description": item.get("description") or "",
                "source": source,
                "format": item.get("format") or "string",
                "required": bool(item.get("isRequired", False)),
                "secret": bool(item.get("isSecret", False)),
                "repeated": bool(item.get("isRepeated", False)),
                "default_value": _coerce_default_value(item.get("default"), item.get("format") or "string"),
                "placeholder": item.get("placeholder") or "",
            })

    variables = item.get("variables") or {}
    if isinstance(variables, dict):
        for name, variable in variables.items():
            fields.extend(_collect_single_field(variable, source=source, fallback_label=name))

    return fields


def _field_needs_user_input(item: Dict[str, Any]) -> bool:
    value = item.get("value")
    return value in (None, "")


def _field_label(item: Dict[str, Any], fallback_label: Optional[str] = None) -> str:
    for key in ("label", "name", "valueHint"):
        value = item.get(key)
        if value:
            return str(value)
    return fallback_label or "配置项"


def _coerce_default_value(value: Any, value_format: str) -> Any:
    if value in (None, ""):
        if value_format == "boolean":
            return False
        return None
    if value_format == "boolean":
        return _parse_bool(value)
    if value_format == "number":
        try:
            number = float(value)
            return int(number) if number.is_integer() else number
        except (TypeError, ValueError):
            return value
    return value


def _infer_runtime_hint(package: Dict[str, Any]) -> Optional[str]:
    runtime_hint = (package.get("runtimeHint") or "").strip()
    if runtime_hint:
        return runtime_hint
    registry_type = (package.get("registryType") or "").strip()
    return SUPPORTED_PACKAGE_RUNTIMES.get(registry_type)


def _build_package_preview(package: Dict[str, Any]) -> str:
    command, args = _resolve_package_runtime(package, input_values={}, allow_placeholders=True)
    return " ".join([command, *args]).strip()


def _build_remote_preview(remote: Dict[str, Any]) -> Optional[str]:
    try:
        return _resolve_template_string(remote.get("url") or "", {}, remote.get("variables") or {}, allow_placeholders=True)
    except Exception:
        return remote.get("url")


def _resolve_package_runtime(
    package: Dict[str, Any],
    input_values: Dict[str, Any],
    allow_placeholders: bool = False,
) -> tuple[str, List[str]]:
    runtime_hint = _infer_runtime_hint(package)
    if not runtime_hint:
        registry_type = package.get("registryType") or "unknown"
        raise ValueError(f"暂不支持自动解析 registryType={registry_type} 的启动命令")

    registry_type = (package.get("registryType") or "").strip()
    identifier = (package.get("identifier") or "").strip()
    if not identifier:
        raise ValueError("Registry package 缺少 identifier")

    runtime_args = _resolve_arguments(package.get("runtimeArguments") or [], input_values, allow_placeholders)
    package_args = _resolve_arguments(package.get("packageArguments") or [], input_values, allow_placeholders)
    version = (package.get("version") or "").strip()

    if runtime_hint == "npx":
        package_spec = f"{identifier}@{version}" if version else identifier
        args = list(runtime_args)
        if not args:
            args.append("-y")
        args.append(package_spec)
        args.extend(package_args)
        return runtime_hint, args

    if runtime_hint == "uvx":
        package_spec = f"{identifier}=={version}" if version else identifier
        args = list(runtime_args)
        args.append(package_spec)
        args.extend(package_args)
        return runtime_hint, args

    if runtime_hint == "docker" or registry_type == "oci":
        args = list(runtime_args)
        if not args or args[0] != "run":
            args = ["run", "-i", "--rm", *args]
        env_items = _resolve_key_value_items(package.get("environmentVariables") or [], input_values, allow_placeholders=allow_placeholders)
        for name, value in env_items.items():
            args.extend(["-e", f"{name}={value}"])
        args.append(identifier)
        args.extend(package_args)
        return "docker", args

    if runtime_hint == "dnx":
        args = list(runtime_args)
        args.append(identifier)
        if version:
            args.extend(["--version", version])
        args.extend(package_args)
        return runtime_hint, args

    raise ValueError(f"暂不支持 runtimeHint={runtime_hint}")


def _resolve_arguments(items: Iterable[Dict[str, Any]], input_values: Dict[str, Any], allow_placeholders: bool) -> List[str]:
    args: List[str] = []
    for item in items:
        args.extend(_resolve_argument(item, input_values, allow_placeholders))
    return args


def _resolve_argument(item: Dict[str, Any], input_values: Dict[str, Any], allow_placeholders: bool) -> List[str]:
    if not isinstance(item, dict):
        return []

    value = _resolve_input_value(item, input_values, allow_placeholders=allow_placeholders)
    if value in (None, ""):
        return []

    values = _expand_repeated_values(value, item.get("isRepeated"), item.get("format") or "string")
    arg_type = item.get("type") or "positional"

    if arg_type == "named":
        name = item.get("name")
        if not name:
            raise ValueError("命名参数缺少 `name`")
        result: List[str] = []
        for current in values:
            if (item.get("format") or "string") == "boolean":
                if _parse_bool(current):
                    result.append(name)
                continue
            result.extend([name, current])
        return result

    return values


def _resolve_key_value_items(
    items: Iterable[Dict[str, Any]],
    input_values: Dict[str, Any],
    allow_placeholders: bool = False,
) -> Dict[str, str]:
    resolved: Dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not name:
            continue
        value = _resolve_input_value(item, input_values, allow_placeholders=allow_placeholders)
        if value in (None, ""):
            continue
        resolved[str(name)] = str(value)
    return resolved


def _resolve_input_value(item: Dict[str, Any], input_values: Dict[str, Any], allow_placeholders: bool = False) -> Optional[str]:
    variables = item.get("variables") or {}
    value_format = item.get("format") or "string"

    if item.get("value") not in (None, ""):
        return _resolve_template_string(str(item.get("value")), input_values, variables, allow_placeholders=allow_placeholders)

    field_key = item.get("client_field_key")
    if field_key in input_values:
        raw = input_values.get(field_key)
        if raw not in (None, ""):
            return _stringify_value(raw, value_format)

    if item.get("default") not in (None, ""):
        default_value = item.get("default")
        if isinstance(default_value, str):
            return _resolve_template_string(default_value, input_values, variables, allow_placeholders=allow_placeholders)
        return _stringify_value(default_value, value_format)

    if allow_placeholders:
        label = _field_label(item, field_key or "value")
        return f"<{label}>"

    if item.get("isRequired", False):
        label = _field_label(item, field_key or "value")
        raise ValueError(f"请填写 {label}")

    return None


def _resolve_template_string(
    template: str,
    input_values: Dict[str, Any],
    variables: Dict[str, Any],
    allow_placeholders: bool = False,
) -> str:
    if not template:
        return ""

    resolved = template
    if isinstance(variables, dict):
        for name, variable in variables.items():
            replacement = _resolve_input_value(variable, input_values, allow_placeholders=allow_placeholders)
            if replacement is None:
                continue
            resolved = resolved.replace(f"{{{name}}}", str(replacement))
    return resolved


def _expand_repeated_values(value: str, is_repeated: Any, value_format: str) -> List[str]:
    if not is_repeated:
        return [value]
    if value_format == "filepath":
        return [value]
    parts = [part.strip() for part in str(value).split(",") if part.strip()]
    return parts or [value]


def _stringify_value(value: Any, value_format: str) -> str:
    if value_format == "boolean":
        return "true" if _parse_bool(value) else "false"
    if value is None:
        return ""
    return str(value)


def _parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _normalize_transport_type(transport_type: str) -> str:
    transport = (transport_type or "").strip().lower().replace("-", "_")
    if transport == "streamablehttp":
        return "streamable_http"
    return transport


def _clean_server_name(value: Optional[str]) -> str:
    if value is None:
        return ""
    sanitized = re.sub(r"[^a-zA-Z0-9_\-]+", "_", str(value).strip().lower())
    sanitized = re.sub(r"_+", "_", sanitized).strip("_")
    return sanitized[:80]

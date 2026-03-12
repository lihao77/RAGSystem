# -*- coding: utf-8 -*-
"""Unified builder for OpenAI-style tool definitions."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence


@dataclass
class ToolContract:
    """Internal canonical representation for a tool definition."""

    name: str
    description: str
    parameters: dict[str, Any]
    allowed_callers: list[str] = field(default_factory=lambda: ["direct"])
    returns: dict[str, Any] | None = None
    usage_contract: list[str] = field(default_factory=list)
    examples: list[dict[str, Any]] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    source: str = "static"


def build_function_tool(contract: ToolContract | Mapping[str, Any]) -> dict[str, Any]:
    """Build an OpenAI-style function tool definition from a canonical contract."""
    resolved = _ensure_contract(contract)
    _validate_contract(resolved)

    function_def: dict[str, Any] = {
        "name": resolved.name,
        "description": resolved.description,
        "parameters": deepcopy(resolved.parameters),
        "allowed_callers": list(resolved.allowed_callers),
    }
    if resolved.returns is not None:
        function_def["returns"] = deepcopy(resolved.returns)
    if resolved.usage_contract:
        function_def["usage_contract"] = list(resolved.usage_contract)
    if resolved.examples:
        function_def["examples"] = deepcopy(resolved.examples)
    if resolved.tags:
        function_def["tags"] = list(resolved.tags)
    if resolved.source:
        function_def["source"] = resolved.source

    return {
        "type": "function",
        "function": function_def,
    }


def build_function_tools(contracts: Iterable[ToolContract | Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Batch-build OpenAI-style function tools."""
    return [build_function_tool(contract) for contract in contracts]


def _ensure_contract(contract: ToolContract | Mapping[str, Any]) -> ToolContract:
    if isinstance(contract, ToolContract):
        return contract
    return ToolContract(**dict(contract))


def _validate_contract(contract: ToolContract) -> None:
    if not contract.name:
        raise ValueError("ToolContract.name 不能为空")
    if not contract.description:
        raise ValueError(f"ToolContract.description 不能为空: {contract.name}")
    if not isinstance(contract.parameters, dict):
        raise TypeError(f"ToolContract.parameters 必须是 dict: {contract.name}")

    schema_type = contract.parameters.get("type")
    if schema_type != "object":
        raise ValueError(f"ToolContract.parameters.type 必须是 'object': {contract.name}")

    properties = contract.parameters.get("properties", {})
    if not isinstance(properties, dict):
        raise TypeError(f"ToolContract.parameters.properties 必须是 dict: {contract.name}")

    required = contract.parameters.get("required", [])
    if not isinstance(required, Sequence) or isinstance(required, (str, bytes)):
        raise TypeError(f"ToolContract.parameters.required 必须是字符串列表: {contract.name}")
    missing = [item for item in required if item not in properties]
    if missing:
        raise ValueError(
            f"ToolContract.parameters.required 包含未定义字段 {missing}: {contract.name}"
        )

    if not isinstance(contract.allowed_callers, Sequence) or isinstance(contract.allowed_callers, (str, bytes)):
        raise TypeError(f"ToolContract.allowed_callers 必须是字符串列表: {contract.name}")
    if not all(isinstance(item, str) for item in contract.allowed_callers):
        raise TypeError(f"ToolContract.allowed_callers 必须只包含字符串: {contract.name}")

    if contract.returns is not None and not isinstance(contract.returns, dict):
        raise TypeError(f"ToolContract.returns 必须是 dict 或 None: {contract.name}")

    if not isinstance(contract.usage_contract, Sequence) or isinstance(contract.usage_contract, (str, bytes)):
        raise TypeError(f"ToolContract.usage_contract 必须是字符串列表: {contract.name}")
    if not all(isinstance(item, str) for item in contract.usage_contract):
        raise TypeError(f"ToolContract.usage_contract 必须只包含字符串: {contract.name}")

    if not isinstance(contract.examples, Sequence) or isinstance(contract.examples, (str, bytes)):
        raise TypeError(f"ToolContract.examples 必须是对象列表: {contract.name}")
    if not all(isinstance(item, Mapping) for item in contract.examples):
        raise TypeError(f"ToolContract.examples 必须只包含对象: {contract.name}")

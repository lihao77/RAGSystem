# -*- coding: utf-8 -*-
"""Shared capability abstractions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List


@dataclass(frozen=True)
class CapabilityDescriptor:
    name: str
    category: str
    description: str


class BaseCapability:
    descriptor: CapabilityDescriptor

    def list_tool_definitions(self) -> List[dict]:
        return []

    def list_descriptors(self) -> Iterable[CapabilityDescriptor]:
        return [self.descriptor]

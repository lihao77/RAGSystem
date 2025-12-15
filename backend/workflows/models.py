# -*- coding: utf-8 -*-
"""工作流数据模型（最小可用版：顺序节点列表）"""

from __future__ import annotations

from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime


class WorkflowNode(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    node_type: str
    config_id: Optional[str] = None


class WorkflowDefinition(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    name: str
    description: str = ""
    nodes: List[WorkflowNode] = Field(default_factory=list)

    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

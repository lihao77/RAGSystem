# -*- coding: utf-8 -*-
"""工作流数据模型（DAG：任意连线）"""

from __future__ import annotations

from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime


class WorkflowNode(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    node_type: str
    config_id: Optional[str] = None
    # 画布坐标（用于可视化编排；引擎不依赖）
    position: Optional[dict] = None


class WorkflowEdge(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:10])
    from_node_id: str
    from_port: str
    to_node_id: str
    to_port: str


class WorkflowDefinition(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    name: str
    description: str = ""
    nodes: List[WorkflowNode] = Field(default_factory=list)
    edges: List[WorkflowEdge] = Field(default_factory=list)

    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

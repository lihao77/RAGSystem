# -*- coding: utf-8 -*-
"""工作流数据模型（DAG：任意连线）"""

from __future__ import annotations

from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime


class WorkflowNode(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    node_type: str
    config_id: Optional[str] = None
    # 画布坐标（用于可视化编排；引擎不依赖）
    position: Optional[Dict[str, Any]] = None
    # 输入绑定：{input_port: "var:xxx" | "node:<node_id>:<out_port>"}
    input_bindings: Optional[Dict[str, str]] = None


class WorkflowEdge(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:10])
    from_node_id: str
    # 作为“连接”(link)时可为空；运行时可由 input_bindings 编译生成
    from_port: Optional[str] = None
    to_node_id: str
    to_port: Optional[str] = None


class WorkflowVariable(BaseModel):
    name: str
    type: str = "any"  # text/json/number/bool/file_ids/any...
    value: Optional[Any] = None


class WorkflowDefinition(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    name: str
    description: str = ""
    variables: List[WorkflowVariable] = Field(default_factory=list)
    nodes: List[WorkflowNode] = Field(default_factory=list)
    edges: List[WorkflowEdge] = Field(default_factory=list)

    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

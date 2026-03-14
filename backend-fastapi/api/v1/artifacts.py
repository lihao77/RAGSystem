# -*- coding: utf-8 -*-
"""Artifact REST API - 前端按 artifact_id 拉取可视化配置。"""

from __future__ import annotations

import logging
from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get('/visualizations/{artifact_id}')
async def get_visualization(artifact_id: str):
    """前端按 artifact_id 拉取完整配置。"""
    from tools.visualization_artifact_manager import get_visualization_artifact_manager

    try:
        manager = get_visualization_artifact_manager()
        config = manager.get_config(artifact_id)
        return config
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未找到可视化 artifact: {artifact_id}")
    except Exception as e:
        logger.error(f"获取可视化配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/visualizations')
async def list_visualizations(session_id: str = Query(..., description="会话 ID")):
    """列出某会话的所有可视化 artifact。"""
    from tools.visualization_artifact_manager import get_visualization_artifact_manager

    try:
        manager = get_visualization_artifact_manager()
        records = manager.list_by_session(session_id)
        return [
            {
                "artifact_id": r.artifact_id,
                "viz_type": r.viz_type,
                "sub_type": r.sub_type,
                "title": r.title,
                "version": r.version,
                "created_at": r.created_at,
                "updated_at": r.updated_at,
            }
            for r in records
        ]
    except Exception as e:
        logger.error(f"列出可视化 artifact 失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))

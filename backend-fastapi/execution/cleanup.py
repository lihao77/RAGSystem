# -*- coding: utf-8 -*-
"""
Run 结束后的资源清理工具函数。
"""

import logging

logger = logging.getLogger(__name__)


def cleanup_after_run(session_id: str, run_id: str) -> None:
    """清理 run 级 EventBus、flush session cache、回收已完成执行。"""
    # 1. 清理目标 run event bus（避免误删同 session 后续新 run）
    try:
        from agents.events.session_manager import cleanup_run
        cleanup_run(run_id)
    except Exception:
        pass

    # 2. flush session cache
    try:
        from agents.context.session_cache import flush_session
        flush_session(session_id)
    except Exception:
        pass

    # 3. 回收已完成执行记录
    try:
        execution_service = None
        try:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if container:
                execution_service = container.get_execution_service()
        except Exception:
            pass
        if execution_service is None:
            from dependencies import get_execution_service
            execution_service = get_execution_service()
        execution_service.cleanup_finished()
    except Exception:
        pass

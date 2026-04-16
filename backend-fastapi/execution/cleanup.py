# -*- coding: utf-8 -*-
"""
Run 结束后的资源清理工具函数。

stream.py 和 notification_trigger.py 的 drain 线程共用。
"""

import logging

logger = logging.getLogger(__name__)


def cleanup_after_run(session_id: str, run_id: str) -> None:
    """清理 run 级 EventBus、flush session cache、回收已完成执行。"""
    # 1. 清理 run event bus（仅在 run 已结束时）
    try:
        from dependencies import get_execution_service
        current_status = get_execution_service().get_status_by_session(session_id)
        should_cleanup = not current_status or current_status.get('status') != 'running'
        if current_status:
            current_run_id = current_status.get('run_id')
            should_cleanup = current_run_id == run_id or current_status.get('status') != 'running'
        if should_cleanup:
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
        from dependencies import get_execution_service
        get_execution_service().cleanup_finished()
    except Exception:
        pass

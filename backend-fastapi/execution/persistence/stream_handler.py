# -*- coding: utf-8 -*-
"""
流式执行持久化处理器。

组合 MessagePersistenceHandler 和 RunStepPersistenceHandler，
对外保持统一接口。
"""

from threading import Event as ThreadingEvent
from typing import Dict, List, Optional

from .message_handler import MessagePersistenceHandler
from .runstep_handler import RunStepPersistenceHandler


class StreamPersistenceHandler:
    """
    流式执行持久化处理器。

    组合消息持久化和运行步骤持久化，对外提供统一接口。
    """

    def __init__(
        self,
        event_bus,
        store,
        session_id: str,
        run_id: str,
        cancel_event: ThreadingEvent,
        entry_agent_name: str = 'orchestrator_agent',
    ):
        self._message_handler = MessagePersistenceHandler(
            event_bus=event_bus,
            store=store,
            session_id=session_id,
            run_id=run_id,
            cancel_event=cancel_event,
            entry_agent_name=entry_agent_name,
        )
        self._runstep_handler = RunStepPersistenceHandler(
            event_bus=event_bus,
            store=store,
            session_id=session_id,
            run_id=run_id,
            message_id_for_run=self._message_handler.message_id_for_run,
        )

    @property
    def final_answer_saved(self) -> ThreadingEvent:
        return self._message_handler.final_answer_saved

    @property
    def message_id_for_run(self) -> List[Optional[str]]:
        return self._message_handler.message_id_for_run

    def subscribe_all(self) -> Dict[str, str]:
        ids = {}
        ids.update(self._message_handler.subscribe_all())
        ids.update(self._runstep_handler.subscribe_all())
        return ids

    def unsubscribe_all(self):
        self._message_handler.unsubscribe_all()
        self._runstep_handler.unsubscribe_all()

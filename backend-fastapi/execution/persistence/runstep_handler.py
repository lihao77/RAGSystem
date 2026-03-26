# -*- coding: utf-8 -*-
"""
运行步骤持久化处理器。

负责将 run_steps 表相关事件持久化到数据库。
"""

import logging
from typing import Any, Dict, List, Optional

from agents.events.bus import EventType

logger = logging.getLogger(__name__)

_STEP_EVENT_TYPES = [EventType.EXECUTION_STEP]


class RunStepPersistenceHandler:
    """
    运行步骤持久化处理器。

    订阅事件总线，将执行步骤事件写入 run_steps 表。
    """

    _DROPPED_PERSISTED_FIELDS = {
        'event_id',
        'timestamp',
        'source_event_type',
        'node_id',
        'parent_node_id',
        'child_agent_id',
        'mode',
        'resource_refs',
        'raw_result_ref',
    }

    def __init__(
        self,
        event_bus,
        store,
        session_id: str,
        run_id: str,
        message_id_for_run: List[Optional[str]],
    ):
        self.event_bus = event_bus
        self.store = store
        self.session_id = session_id
        self.run_id = run_id
        # 与 MessagePersistenceHandler 共享的引用，RUN_END 时用于关联 message_id
        self.message_id_for_run = message_id_for_run

        self._subscription_id: Optional[str] = None

    def subscribe_all(self) -> dict:
        self._subscription_id = self._subscribe_run_steps()
        return {'run_steps': self._subscription_id}

    def unsubscribe_all(self):
        if self._subscription_id:
            try:
                self.event_bus.unsubscribe(self._subscription_id)
            except Exception:
                pass
            self._subscription_id = None

    def _subscribe_run_steps(self) -> str:
        def handle(event):
            payload = dict(event.data or {})
            kind = payload.get('kind')
            phase = payload.get('phase')
            if (kind == 'intent' and phase == 'delta') or (kind == 'round' and phase == 'update'):
                return
            resource_refs = payload.get('resource_refs') or []
            persisted_payload = {
                key: value
                for key, value in payload.items()
                if key not in self._DROPPED_PERSISTED_FIELDS
            }
            if persisted_payload.get('result_preview') is not None:
                persisted_payload.pop('result', None)
            try:
                step_result = self.store.add_run_step(
                    session_id=self.session_id,
                    run_id=self.run_id,
                    step_type=EventType.EXECUTION_STEP.value,
                    payload=persisted_payload,
                    message_id=None,
                )
            except Exception as error:
                logger.warning('写入 run_step 失败: %s', error, exc_info=True)
                step_result = None

            if payload.get('kind') == 'tool' and payload.get('phase') == 'end' and step_result:
                step_id = step_result.get('id')
                if step_id and resource_refs:
                    for ref in resource_refs:
                        rid = ref.get('resource_id')
                        if rid:
                            try:
                                self.store.attach_resource_to_step(
                                    session_id=self.session_id,
                                    run_id=self.run_id,
                                    step_id=step_id,
                                    resource_id=rid,
                                )
                            except Exception as error:
                                logger.warning('关联资源到步骤失败: %s', error, exc_info=True)

            if payload.get('kind') == 'run' and payload.get('phase') == 'end':
                try:
                    status = payload.get('status', 'completed')
                    self.store.update_run_status(
                        run_id=self.run_id,
                        session_id=self.session_id,
                        status=status,
                        final_message_id=self.message_id_for_run[0] if self.message_id_for_run else None,
                    )
                except Exception as error:
                    logger.warning('RUN_END 时更新 run 状态失败: %s', error, exc_info=True)

                if self.message_id_for_run and self.message_id_for_run[0]:
                    try:
                        self.store.update_run_steps_message_id(
                            self.session_id, self.run_id, self.message_id_for_run[0]
                        )
                    except Exception as error:
                        logger.warning('RUN_END 时更新 run_steps message_id 失败: %s', error, exc_info=True)

        return self.event_bus.subscribe(
            event_types=_STEP_EVENT_TYPES,
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
        )


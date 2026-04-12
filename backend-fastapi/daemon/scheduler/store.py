# -*- coding: utf-8 -*-
"""
Cron 任务持久化存储。

以 YAML 文件持久化 Cron 任务配置。
运行时状态（last_run/next_run）仅保存在内存中。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional

import yaml

from daemon.models import CronTask

logger = logging.getLogger(__name__)


class CronTaskStore:
    """Cron 任务 YAML 持久化。"""

    def __init__(self, config_dir: Path):
        self._file = config_dir / "cron_tasks.yaml"
        self._tasks: List[CronTask] = []
        self._load()

    def _load(self) -> None:
        if not self._file.exists():
            self._tasks = []
            return
        try:
            with open(self._file, 'r', encoding='utf-8') as f:
                raw_list = yaml.safe_load(f) or []
            self._tasks = [CronTask.model_validate(t) for t in raw_list]
        except Exception as e:
            logger.error('加载 cron 任务失败: %s', e)
            self._tasks = []

    def save(self) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        with open(self._file, 'w', encoding='utf-8') as f:
            yaml.dump(
                [t.model_dump(exclude={'last_run', 'next_run', 'last_result'}) for t in self._tasks],
                f,
                allow_unicode=True,
                default_flow_style=False,
            )

    def get_all(self) -> List[CronTask]:
        return list(self._tasks)

    def add(self, task: CronTask) -> None:
        self._tasks.append(task)
        self.save()

    def update(self, task_id: str, updates: dict) -> Optional[CronTask]:
        for t in self._tasks:
            if t.task_id == task_id:
                for k, v in updates.items():
                    if hasattr(t, k):
                        setattr(t, k, v)
                self.save()
                return t
        return None

    def delete(self, task_id: str) -> bool:
        before = len(self._tasks)
        self._tasks = [t for t in self._tasks if t.task_id != task_id]
        if len(self._tasks) < before:
            self.save()
            return True
        return False

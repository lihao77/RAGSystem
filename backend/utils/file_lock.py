# -*- coding: utf-8 -*-
"""轻量级文件锁。"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Optional


_LOCK_STATE: dict[Path, dict[str, int]] = {}
_LOCK_STATE_GUARD = threading.RLock()


class FileLock:
    """基于锁文件的可重入本地文件锁。"""

    def __init__(
        self,
        path: str | Path,
        *,
        timeout: float = 5.0,
        poll_interval: float = 0.05,
        stale_timeout: float = 60.0,
    ):
        self.target_path = Path(path)
        self.lock_path = self.target_path.with_name(f'.{self.target_path.name}.lock')
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.stale_timeout = stale_timeout
        self._thread_id = threading.get_ident()
        self._acquired = False

    def __enter__(self) -> 'FileLock':
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()

    def acquire(self) -> None:
        with _LOCK_STATE_GUARD:
            state = _LOCK_STATE.get(self.lock_path)
            if state is not None and state['thread_id'] == self._thread_id:
                state['count'] += 1
                self._acquired = True
                return

        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.lock_path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, f'{os.getpid()}:{self._thread_id}'.encode('utf-8'))
                finally:
                    os.close(fd)

                with _LOCK_STATE_GUARD:
                    _LOCK_STATE[self.lock_path] = {'thread_id': self._thread_id, 'count': 1}
                self._acquired = True
                return
            except FileExistsError:
                if self._is_stale_lock():
                    self.lock_path.unlink(missing_ok=True)
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'获取文件锁超时: {self.lock_path}')
                time.sleep(self.poll_interval)

    def release(self) -> None:
        if not self._acquired:
            return

        remove_lock_file = False
        with _LOCK_STATE_GUARD:
            state = _LOCK_STATE.get(self.lock_path)
            if state is None or state['thread_id'] != self._thread_id:
                raise RuntimeError(f'当前线程未持有文件锁: {self.lock_path}')

            if state['count'] > 1:
                state['count'] -= 1
            else:
                _LOCK_STATE.pop(self.lock_path, None)
                remove_lock_file = True

        if remove_lock_file:
            self.lock_path.unlink(missing_ok=True)

        self._acquired = False

    def _is_stale_lock(self) -> bool:
        if not self.lock_path.exists():
            return False
        age_seconds = time.time() - self.lock_path.stat().st_mtime
        return age_seconds > self.stale_timeout

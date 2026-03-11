# -*- coding: utf-8 -*-
"""Observation window metrics for Phase B -> C migration."""

from __future__ import annotations

import atexit
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_DEFAULT_STORAGE_PATH = _DEFAULT_STORAGE_DIR / "observation_window.json"
_MAX_SAMPLES = 1000
_ARTIFACT_BUCKETS = (
    (10 * 1024, "<10KB"),
    (100 * 1024, "10KB-100KB"),
    (1024 * 1024, "100KB-1MB"),
    (10 * 1024 * 1024, "1MB-10MB"),
)


def _new_state() -> Dict[str, Any]:
    return {
        "window": {
            "started_at": None,
            "updated_at": None,
        },
        "totals": {
            "normalized_results": 0,
            "materialized_results": 0,
            "artifact_saves": 0,
        },
        "output_type_distribution": {},
        "normalize_branch_distribution": {},
        "threshold_stats": {
            "large_data_threshold": 8000,
            "triggered": 0,
            "not_triggered": 0,
        },
        "inline_size_samples": [],
        "artifact_size_samples": [],
        "artifact_type_distribution": {},
        "artifact_size_buckets": {},
        "tools": {},
    }


class ObservationWindowCollector:
    """Collect real result-shape and materialization distributions before policy rollout."""

    def __init__(
        self,
        storage_path: Optional[Path | str] = None,
        persist_interval_seconds: float = 5.0,
    ):
        self._storage_path = Path(storage_path) if storage_path else _DEFAULT_STORAGE_PATH
        self._persist_interval = persist_interval_seconds
        self._last_persist_time = 0.0
        self._lock = threading.RLock()
        self._state = _new_state()
        self._load()
        atexit.register(self._persist_on_exit)

    def record_normalization(
        self,
        *,
        tool_name: str,
        output_type: str,
        branch: str,
        success: bool,
    ) -> None:
        with self._lock:
            state = self._state
            self._touch_window()
            state["totals"]["normalized_results"] += 1
            self._increment(state["output_type_distribution"], output_type)
            self._increment(state["normalize_branch_distribution"], branch)

            tool_stats = self._tool_stats(tool_name)
            tool_stats["normalized_results"] += 1
            self._increment(tool_stats["output_type_distribution"], output_type)
            self._increment(tool_stats["normalize_branch_distribution"], branch)
            if success:
                tool_stats["success_count"] += 1
            else:
                tool_stats["failure_count"] += 1

            self._persist()

    def record_materialization(
        self,
        *,
        tool_name: str,
        output_type: str,
        estimated_size: int,
        threshold: int,
        used_artifact: bool,
    ) -> None:
        del output_type
        with self._lock:
            state = self._state
            self._touch_window()
            state["totals"]["materialized_results"] += 1
            state["threshold_stats"]["large_data_threshold"] = threshold
            if used_artifact:
                state["threshold_stats"]["triggered"] += 1
            else:
                state["threshold_stats"]["not_triggered"] += 1
                self._append_sample(state["inline_size_samples"], estimated_size)

            tool_stats = self._tool_stats(tool_name)
            tool_stats["materialized_results"] += 1
            if used_artifact:
                tool_stats["artifact_ref_count"] += 1
            else:
                tool_stats["inline_count"] += 1
                self._append_sample(tool_stats["inline_size_samples"], estimated_size)

            self._persist()

    def record_artifact_saved(
        self,
        *,
        tool_name: str,
        artifact_type: str,
        size: int,
    ) -> None:
        with self._lock:
            state = self._state
            self._touch_window()
            state["totals"]["artifact_saves"] += 1
            self._append_sample(state["artifact_size_samples"], size)
            self._increment(state["artifact_type_distribution"], artifact_type)
            self._increment(state["artifact_size_buckets"], self._artifact_bucket(size))

            tool_stats = self._tool_stats(tool_name)
            tool_stats["artifact_saves"] += 1
            tool_stats["artifact_bytes"] += size
            self._append_sample(tool_stats["artifact_size_samples"], size)

            self._persist()

    def build_report(self) -> Dict[str, Any]:
        with self._lock:
            state = json.loads(json.dumps(self._state))

        inline_samples = state["inline_size_samples"]
        artifact_samples = state["artifact_size_samples"]
        triggered = state["threshold_stats"]["triggered"]
        not_triggered = state["threshold_stats"]["not_triggered"]
        total_threshold = triggered + not_triggered

        suggested_snippet_limit = None
        if inline_samples:
            sorted_samples = sorted(inline_samples)
            index = min(len(sorted_samples) - 1, int(len(sorted_samples) * 0.95))
            suggested_snippet_limit = sorted_samples[index]

        artifact_avg = 0
        if artifact_samples:
            artifact_avg = int(sum(artifact_samples) / len(artifact_samples))

        tool_report = []
        for tool_name, stats in sorted(state["tools"].items()):
            tool_report.append(
                {
                    "tool_name": tool_name,
                    "normalized_results": stats["normalized_results"],
                    "output_type_distribution": stats["output_type_distribution"],
                    "normalize_branch_distribution": stats["normalize_branch_distribution"],
                    "inline_count": stats["inline_count"],
                    "artifact_ref_count": stats["artifact_ref_count"],
                    "artifact_saves": stats["artifact_saves"],
                    "artifact_avg_size_bytes": int(
                        sum(stats["artifact_size_samples"]) / len(stats["artifact_size_samples"])
                    ) if stats["artifact_size_samples"] else 0,
                }
            )

        return {
            "window": state["window"],
            "counts": state["totals"],
            "output_type_distribution": state["output_type_distribution"],
            "normalize_branch_distribution": state["normalize_branch_distribution"],
            "threshold_stats": {
                **state["threshold_stats"],
                "trigger_rate": (triggered / total_threshold) if total_threshold else 0.0,
            },
            "artifact_stats": {
                "count": len(artifact_samples),
                "average_size_bytes": artifact_avg,
                "max_size_bytes": max(artifact_samples) if artifact_samples else 0,
                "type_distribution": state["artifact_type_distribution"],
                "size_buckets": state["artifact_size_buckets"],
            },
            "recommendations": {
                "suggested_snippet_limit": suggested_snippet_limit,
                "artifact_storage_tiering_recommended": artifact_avg >= 1024 * 1024,
            },
            "tool_coverage": tool_report,
        }

    def save_report(self) -> Dict[str, Any]:
        report = self.build_report()
        with self._lock:
            self._persist(force=True)
        return report

    def reset(self) -> None:
        with self._lock:
            self._state = _new_state()
            self._persist(force=True)

    def _persist_on_exit(self) -> None:
        try:
            self._persist(force=True)
        except Exception as exc:
            logger.warning("ObservationWindowCollector 退出保存失败: %s", exc)

    def _load(self) -> None:
        if not self._storage_path.exists():
            return
        try:
            with open(self._storage_path, "r", encoding="utf-8") as file_obj:
                data = json.load(file_obj)
            if isinstance(data, dict):
                self._state.update(data)
        except Exception as exc:
            logger.warning("ObservationWindowCollector 加载失败: %s", exc)

    def _persist(self, force: bool = False) -> None:
        if not force and (time.time() - self._last_persist_time) < self._persist_interval:
            return
        self._storage_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._storage_path, "w", encoding="utf-8") as file_obj:
            json.dump(self._state, file_obj, ensure_ascii=False, indent=2)
        self._last_persist_time = time.time()

    def _touch_window(self) -> None:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not self._state["window"]["started_at"]:
            self._state["window"]["started_at"] = now
        self._state["window"]["updated_at"] = now

    def _tool_stats(self, tool_name: str) -> Dict[str, Any]:
        key = tool_name or "__unknown__"
        tools = self._state["tools"]
        if key not in tools:
            tools[key] = {
                "normalized_results": 0,
                "success_count": 0,
                "failure_count": 0,
                "materialized_results": 0,
                "inline_count": 0,
                "artifact_ref_count": 0,
                "artifact_saves": 0,
                "artifact_bytes": 0,
                "output_type_distribution": {},
                "normalize_branch_distribution": {},
                "inline_size_samples": [],
                "artifact_size_samples": [],
            }
        return tools[key]

    @staticmethod
    def _increment(target: Dict[str, int], key: str) -> None:
        key = key or "__unknown__"
        target[key] = target.get(key, 0) + 1

    @staticmethod
    def _append_sample(samples: List[int], value: int) -> None:
        if len(samples) < _MAX_SAMPLES:
            samples.append(int(value))

    @staticmethod
    def _artifact_bucket(size: int) -> str:
        for upper_bound, label in _ARTIFACT_BUCKETS:
            if size < upper_bound:
                return label
        return ">=10MB"

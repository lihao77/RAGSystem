# -*- coding: utf-8 -*-
"""Print the current observation window report."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from agents.monitoring.observation_window import ObservationWindowCollector


def main() -> None:
    collector = ObservationWindowCollector()
    report = collector.build_report()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""matplotlib 兜底：ECharts 配置校验失败时生成 PNG。"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def fallback_chart_to_image(
    data: List[Dict[str, Any]],
    chart_type: str,
    title: str,
    x_field: str,
    y_field: str,
    session_id: str | None = None,
):
    """
    用 matplotlib 生成 PNG 图表并存入可视化目录。

    Returns:
        VisualizationRecord (viz_type="image")
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.font_manager as fm

    # 尝试使用中文字体
    for font_name in ["SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC"]:
        if any(font_name in f.name for f in fm.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [font_name]
            plt.rcParams["axes.unicode_minus"] = False
            break

    fig, ax = plt.subplots(figsize=(8, 5))
    x_values = [row.get(x_field, "") for row in data]
    y_values = [float(row.get(y_field, 0) or 0) for row in data]

    if chart_type == "bar":
        ax.bar(range(len(x_values)), y_values, tick_label=x_values)
    elif chart_type == "line":
        ax.plot(range(len(x_values)), y_values, marker="o")
        ax.set_xticks(range(len(x_values)))
        ax.set_xticklabels(x_values)
    elif chart_type == "pie":
        ax.pie(y_values, labels=x_values, autopct="%1.1f%%")
    elif chart_type == "scatter":
        ax.scatter(range(len(x_values)), y_values)
        ax.set_xticks(range(len(x_values)))
        ax.set_xticklabels(x_values)
    else:
        ax.bar(range(len(x_values)), y_values, tick_label=x_values)

    ax.set_title(title)
    if chart_type != "pie":
        ax.set_xlabel(x_field)
        ax.set_ylabel(y_field)

    # 旋转 X 轴标签
    plt.xticks(rotation=45, ha="right")
    plt.tight_layout()

    # 保存
    from tools.path_resolution import get_session_visualizations_root, SESSIONS_ROOT
    out_dir = get_session_visualizations_root(session_id) if session_id else (SESSIONS_ROOT / 'anonymous' / 'visualizations')
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"viz_{uuid.uuid4().hex[:8]}.png"
    filepath = os.path.join(str(out_dir), filename)
    fig.savefig(filepath, dpi=150, bbox_inches="tight")
    plt.close(fig)

    logger.info("matplotlib 兜底图表已生成: %s", filepath)

    from tools.visualization_artifact_manager import get_visualization_artifact_manager
    manager = get_visualization_artifact_manager()
    return manager.create_image(
        session_id=session_id,
        image_path=filepath,
        title=title,
    )

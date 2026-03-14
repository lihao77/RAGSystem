# -*- coding: utf-8 -*-
"""
visualization_tools 工具模块（重构版）。

废弃：generate_chart, update_chart_config, present_chart
新增：create_chart, create_map, revise_visualization
"""

import logging
from tools.response_builder import error_result, success_result
from tools.visualization_artifact_manager import get_visualization_artifact_manager

logger = logging.getLogger(__name__)


def _dataframe_from_chart_payload(content, pd):
    """Normalize supported chart payload shapes into a DataFrame."""
    if isinstance(content, list):
        return pd.DataFrame(content)

    if isinstance(content, dict):
        if 'results' in content:
            return _dataframe_from_chart_payload(content['results'], pd)

        try:
            return pd.DataFrame(content)
        except Exception as error:
            raise ValueError(f"字典数据无法转换为表格: {error}") from error

    raise ValueError("数据格式错误：需要列表、列式字典或包含 results 字段的字典")


def _load_dataframe(data, tool_name):
    """通用数据加载逻辑，返回 (df, error_result)。"""
    import pandas as pd
    import json
    import os

    df = None
    if isinstance(data, str):
        try:
            content = json.loads(data)
            try:
                df = _dataframe_from_chart_payload(content, pd)
            except ValueError as error:
                return None, error_result(str(error), tool_name=tool_name)
        except json.JSONDecodeError:
            if os.path.exists(data):
                try:
                    if data.endswith('.csv'):
                        df = pd.read_csv(data)
                    else:
                        df = pd.read_json(data)
                except Exception:
                    try:
                        with open(data, 'r', encoding='utf-8') as f:
                            content = json.load(f)
                            try:
                                df = _dataframe_from_chart_payload(content, pd)
                            except ValueError:
                                return None, error_result("文件内容无法解析为表格", tool_name=tool_name)
                    except Exception as e:
                        return None, error_result(f"无法读取数据文件: {str(e)}", tool_name=tool_name)
            else:
                return None, error_result(
                    f"数据既不是有效的 JSON 字符串，也不是存在的文件路径: {data[:100]}...",
                    tool_name=tool_name,
                )
    elif isinstance(data, list):
        df = pd.DataFrame(data)
    elif isinstance(data, dict):
        try:
            df = _dataframe_from_chart_payload(data, pd)
        except ValueError as error:
            return None, error_result(str(error), tool_name=tool_name)
    else:
        return None, error_result("数据格式错误：需要列表、字典或文件路径", tool_name=tool_name)

    if df is None or df.empty:
        return None, error_result("数据为空", tool_name=tool_name)

    return df, None


def _validate_chart_config(option):
    """校验 ECharts 配置的有效性。返回 (valid, error_msg)。"""
    if not isinstance(option, dict):
        return False, "配置不是有效的字典"
    series = option.get("series")
    if not isinstance(series, list) or not series:
        return False, "配置缺少有效的 series"
    return True, None


def _build_chart_preview(option, chart_type):
    """构建图表预览摘要。"""
    title_block = option.get("title", {})
    title = title_block.get("text", "") if isinstance(title_block, dict) else ""

    series = option.get("series", [])
    series_count = len(series) if isinstance(series, list) else 0

    dataset = option.get("dataset", {})
    data_rows = 0
    if isinstance(dataset, dict):
        source = dataset.get("source")
        if isinstance(source, list):
            data_rows = len(source)

    return {
        "title": title or "未命名图表",
        "chart_type": chart_type,
        "series_count": series_count,
        "data_rows": data_rows,
    }


def create_chart(data, chart_type=None, title="",
                 x_field="", y_field="", series_field="", session_id=None):
    """
    一步完成：生成 ECharts 配置 -> 校验 -> 持久化 -> 返回 artifact_id。

    Agent 在 <final_answer> 中用 [viz:artifact_id] 展示图表。
    """
    import numpy as np

    try:
        logger.info(f"create_chart: chart_type={chart_type}, x_field={x_field}, y_field={y_field}")

        missing = []
        if not x_field:
            missing.append("x_field")
        if not y_field:
            missing.append("y_field")
        if not chart_type:
            chart_type = 'bar'

        if missing:
            return error_result(
                f"缺少必填参数: {', '.join(missing)}。请根据数据元数据，明确指定 X 轴和 Y 轴的字段名。",
                tool_name="create_chart",
            )

        df, err = _load_dataframe(data, "create_chart")
        if err:
            return err

        logger.info(f"[create_chart] 数据加载成功，形状: {df.shape}, 列: {df.columns.tolist()}")

        columns = df.columns.tolist()
        if x_field not in columns:
            return error_result(
                f"X轴字段 '{x_field}' 在数据中不存在。可用字段: {columns}",
                tool_name="create_chart",
            )
        if y_field not in columns:
            return error_result(
                f"Y轴字段 '{y_field}' 在数据中不存在。可用字段: {columns}",
                tool_name="create_chart",
            )
        if series_field and series_field not in columns:
            return error_result(
                f"系列字段 '{series_field}' 在数据中不存在。可用字段: {columns}",
                tool_name="create_chart",
            )

        dataset_source = df.replace({np.nan: None}).to_dict(orient='records')
        final_title = title or f"{y_field} 随 {x_field} 变化"

        option = {
            "title": {"text": final_title, "left": "center"},
            "tooltip": {"trigger": "axis" if chart_type != 'pie' else 'item'},
            "legend": {"top": "bottom"},
            "dataset": {"source": dataset_source},
            "xAxis": {"type": "category", "name": x_field} if chart_type != 'pie' else None,
            "yAxis": {"type": "value", "name": y_field} if chart_type != 'pie' else None,
            "series": [],
        }

        if series_field:
            try:
                pivot_df = df.pivot(index=x_field, columns=series_field, values=y_field).reset_index()
                option['dataset']['source'] = pivot_df.replace({np.nan: None}).to_dict(orient='records')
                for s_name in [c for c in pivot_df.columns if c != x_field]:
                    option['series'].append({
                        "type": chart_type,
                        "name": str(s_name),
                        "encode": {"x": x_field, "y": s_name},
                    })
            except Exception as e:
                return error_result(
                    f"数据透视失败（可能存在重复的 X+Series 组合）: {str(e)}",
                    tool_name="create_chart",
                )
        else:
            series_cfg = {
                "type": chart_type,
                "encode": {"x": x_field, "y": y_field},
                "name": y_field,
            }
            if chart_type == 'pie':
                series_cfg['encode'] = {"itemName": x_field, "value": y_field}
                series_cfg['radius'] = '50%'
            option['series'].append(series_cfg)

        valid, err_msg = _validate_chart_config(option)
        if not valid:
            logger.warning(f"ECharts 配置校验失败: {err_msg}，使用 matplotlib 兜底")
            try:
                from tools.visualization_fallback import fallback_chart_to_image
                record = fallback_chart_to_image(
                    data=dataset_source,
                    chart_type=chart_type,
                    title=final_title,
                    x_field=x_field,
                    y_field=y_field,
                    session_id=session_id,
                )
                return success_result(
                    content={
                        "artifact_id": record.artifact_id,
                        "viz_type": "image",
                        "title": record.title,
                        "preview": {"title": record.title, "chart_type": chart_type, "fallback": True},
                    },
                    summary=f"图表已生成（兜底PNG）：{final_title}",
                    output_type="chart",
                    tool_name="create_chart",
                    llm_hint=f"在 <final_answer> 中插入 [viz:{record.artifact_id}] 来展示此图表",
                )
            except Exception as fallback_err:
                return error_result(
                    f"图表生成失败: {err_msg}; 兜底也失败: {fallback_err}",
                    tool_name="create_chart",
                )

        manager = get_visualization_artifact_manager()
        record = manager.create_chart(
            session_id=session_id,
            chart_config=option,
            chart_type=chart_type,
            title=final_title,
        )

        preview = _build_chart_preview(option, chart_type)
        logger.info(f"图表已持久化: artifact_id={record.artifact_id}, chart_type={chart_type}")

        return success_result(
            content={
                "artifact_id": record.artifact_id,
                "viz_type": "chart",
                "title": final_title,
                "preview": preview,
            },
            summary=(
                f"图表已生成：{final_title}"
                f"（{chart_type}，{preview['series_count']}个系列，{preview['data_rows']}行数据）"
            ),
            output_type="chart",
            tool_name="create_chart",
            llm_hint=f"在 <final_answer> 中插入 [viz:{record.artifact_id}] 来展示此图表",
        )

    except Exception as e:
        return error_result(f"生成图表失败: {str(e)}", tool_name="create_chart")


def create_map(data, map_type="heatmap", title="", name_field="", value_field="",
               geometry_field="geometry", session_id=None):
    """
    一步完成：生成 Leaflet 地图数据 -> 持久化 -> 返回 artifact_id。

    Agent 在 <final_answer> 中用 [viz:artifact_id] 展示地图。
    """
    import pandas as pd
    import re

    try:
        if not value_field:
            return error_result("缺少必填参数: value_field。请指定数值字段。", tool_name="create_map")

        supported_types = ['heatmap', 'marker', 'circle']
        if map_type not in supported_types:
            return error_result(
                f"不支持的地图类型: {map_type}。支持的类型: {', '.join(supported_types)}",
                tool_name="create_map",
            )

        df, err = _load_dataframe(data, "create_map")
        if err:
            return err

        columns = df.columns.tolist()
        if value_field not in columns:
            return error_result(
                f"数值字段 '{value_field}' 在数据中不存在。可用字段: {columns}",
                tool_name="create_map",
            )
        if geometry_field not in columns:
            return error_result(
                f"几何字段 '{geometry_field}' 在数据中不存在。可用字段: {columns}\n"
                "请确保数据包含 geometry 字段（WKT格式，如 'POINT (lng lat)'）",
                tool_name="create_map",
            )

        def parse_wkt_point(wkt_str):
            if pd.isna(wkt_str) or not isinstance(wkt_str, str):
                return None
            match = re.search(r'POINT\s*\(\s*([\d.+-]+)\s+([\d.+-]+)\s*\)', wkt_str, re.IGNORECASE)
            if match:
                return (float(match.group(2)), float(match.group(1)))
            return None

        heat_data = []
        markers = []
        valid_count = 0

        values = df[value_field].dropna().astype(float)
        if len(values) == 0:
            return error_result(f"{value_field} 字段没有有效的数值数据", tool_name="create_map")

        min_value = float(values.min())
        max_value = float(values.max())

        for idx, row in df.iterrows():
            coords = parse_wkt_point(row[geometry_field])
            if coords is None:
                continue

            lat, lng = coords
            value = float(row[value_field]) if pd.notnull(row[value_field]) else 0

            if max_value > min_value:
                normalized_intensity = 0.1 + 0.9 * (value - min_value) / (max_value - min_value)
            else:
                normalized_intensity = 0.5

            heat_data.append([lat, lng, normalized_intensity])

            marker_data = {"lat": lat, "lng": lng, "value": value}
            if name_field and name_field in columns and pd.notnull(row[name_field]):
                marker_data["name"] = str(row[name_field])
            else:
                marker_data["name"] = f"点 {valid_count + 1}"

            if map_type == 'circle':
                if max_value > min_value:
                    normalized = (value - min_value) / (max_value - min_value)
                    marker_data["radius"] = int(500 + normalized * 4500)
                else:
                    marker_data["radius"] = 2000

            markers.append(marker_data)
            valid_count += 1

        if valid_count == 0:
            return error_result(
                f"没有有效的地理坐标数据。请检查 {geometry_field} 字段是否包含有效的 WKT POINT 格式。",
                tool_name="create_map",
            )

        lats = [point[0] for point in heat_data]
        lngs = [point[1] for point in heat_data]
        bounds = [[min(lats), min(lngs)], [max(lats), max(lngs)]]
        center = [(min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2]

        if not title:
            map_type_name = {
                'heatmap': '热力图', 'marker': '标记点地图', 'circle': '圆圈标记地图'
            }.get(map_type, '地图')
            title = f"{value_field}分布{map_type_name}"

        map_data = {
            "map_type": map_type,
            "heat_data": heat_data if map_type == 'heatmap' else [],
            "markers": markers if map_type in ['marker', 'circle'] else [],
            "bounds": bounds,
            "center": center,
            "title": title,
            "value_field": value_field,
            "total_points": valid_count,
            "value_range": {"min": min_value, "max": max_value},
        }

        manager = get_visualization_artifact_manager()
        record = manager.create_map(
            session_id=session_id,
            map_data=map_data,
            map_type=map_type,
            title=title,
        )

        logger.info(f"地图已持久化: artifact_id={record.artifact_id}, map_type={map_type}")

        return success_result(
            content={
                "artifact_id": record.artifact_id,
                "viz_type": "map",
                "title": title,
                "preview": {
                    "map_type": map_type,
                    "total_points": valid_count,
                    "center": center,
                },
            },
            summary=f"地图已生成：{title}（{map_type}，{valid_count}个数据点）",
            output_type="map",
            tool_name="create_map",
            llm_hint=f"在 <final_answer> 中插入 [viz:{record.artifact_id}] 来展示此地图",
        )

    except Exception as e:
        logger.error(f"生成地图失败: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return error_result(f"生成地图失败: {str(e)}", tool_name="create_map")


def revise_visualization(artifact_id, config_patch, replace=False):
    """
    修改已生成的可视化 artifact 配置。

    同一个 artifact_id，前端拉取时自动拿最新版。
    """
    try:
        if not artifact_id:
            return error_result("缺少 artifact_id", tool_name="revise_visualization")
        if not isinstance(config_patch, dict):
            return error_result("config_patch 必须是对象", tool_name="revise_visualization")

        manager = get_visualization_artifact_manager()
        record = manager.revise(artifact_id, config_patch, replace=replace)

        return success_result(
            content={
                "artifact_id": record.artifact_id,
                "viz_type": record.viz_type,
                "title": record.title,
                "version": record.version,
            },
            summary=f"可视化 {record.artifact_id} 已更新至 v{record.version}",
            output_type=record.viz_type,
            tool_name="revise_visualization",
            llm_hint=f"artifact_id 不变，仍使用 [viz:{record.artifact_id}] 展示",
        )
    except Exception as e:
        return error_result(f"修改可视化失败: {str(e)}", tool_name="revise_visualization")


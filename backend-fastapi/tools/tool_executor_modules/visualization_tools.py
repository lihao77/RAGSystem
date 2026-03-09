# -*- coding: utf-8 -*-
"""
visualization_tools 工具模块。
"""

import logging
from .shared import error_response, success_response

logger = logging.getLogger(__name__)

def generate_chart(data, chart_type=None, title="",
                   x_field="", y_field="", series_field=""):
    """
    生成图表配置 (纯代码逻辑版)

    直接根据 Agent 传入的参数生成 ECharts 配置，不进行复杂的推断。
    Agent 负责指定 chart_type, x_field, y_field。

    返回格式（标准化）:
    {
        "success": True,
        "data": {
            "results": {"echarts_config": {...}},  # 图表配置
            "metadata": {...},                      # 自动生成
            "summary": "..."                        # 自动生成
        }
    }

    Args:
        data: 数据列表（List[Dict]）或数据文件路径（str）
        chart_type: 指定图表类型 ('line', 'bar', 'pie', 'scatter') - 必填
        title: 图表标题
        x_field: X轴字段名 - 必填
        y_field: Y轴字段名 - 必填
        series_field: 系列分组字段名
    """
    import pandas as pd
    import json
    import os

    try:
        logger.info(f"生成图表: chart_type={chart_type}, x_field={x_field}, y_field={y_field}")

        # 1. 快速检查必填参数 (Fail Fast)
        missing_params = []
        if not x_field: missing_params.append("x_field")
        if not y_field: missing_params.append("y_field")
        if not chart_type: chart_type = 'bar'

        if missing_params:
            return error_response(
                f"缺少必填参数: {', '.join(missing_params)}。请根据数据元数据，明确指定 X 轴和 Y 轴的字段名。"
            )

        # 2. 数据加载
        df = None
        if isinstance(data, str):
            # 首先尝试解析为 JSON 字符串
            try:
                content = json.loads(data)
                if isinstance(content, list):
                    df = pd.DataFrame(content)
                elif isinstance(content, dict) and 'results' in content:
                    df = pd.DataFrame(content['results'])
                else:
                    return error_response("JSON 数据格式错误：需要列表或包含 results 字段的字典")
            except json.JSONDecodeError:
                # 如果不是 JSON 字符串，尝试作为文件路径处理
                if os.path.exists(data):
                    try:
                        if data.endswith('.csv'):
                            df = pd.read_csv(data)
                        else:
                            df = pd.read_json(data)
                    except Exception:
                         # 兜底：尝试标准 JSON 读取
                        try:
                            with open(data, 'r', encoding='utf-8') as f:
                                content = json.load(f)
                                if isinstance(content, list):
                                    df = pd.DataFrame(content)
                                elif isinstance(content, dict) and 'results' in content:
                                    df = pd.DataFrame(content['results'])
                                else:
                                    return error_response("文件内容无法解析为表格")
                        except Exception as e:
                            return error_response(f"无法读取数据文件: {str(e)}")
                else:
                    return error_response(f"数据既不是有效的 JSON 字符串，也不是存在的文件路径: {data[:100]}...")
        elif isinstance(data, list):
            df = pd.DataFrame(data)
        else:
            return error_response("数据格式错误：需要列表或文件路径")

        if df is None or df.empty:
            return error_response("数据为空")

        logger.info(f"[generate_chart] 数据加载成功，形状: {df.shape}, 列: {df.columns.tolist()}")

        # 3. 验证字段存在性
        columns = df.columns.tolist()
        if x_field not in columns:
            return error_response(f"X轴字段 '{x_field}' 在数据中不存在。可用字段: {columns}")
        if y_field not in columns:
            return error_response(f"Y轴字段 '{y_field}' 在数据中不存在。可用字段: {columns}")
        if series_field and series_field not in columns:
            return error_response(f"系列字段 '{series_field}' 在数据中不存在。可用字段: {columns}")

        # 4. 构建 ECharts Option
        # 转换数据 (处理 NaN) - 使用 replace 替换 NaN 为 None
        import numpy as np
        import math
        dataset_source = df.replace({np.nan: None}).to_dict(orient='records')

        # 智能生成标题
        final_title = title
        if not final_title:
            final_title = f"{y_field} 随 {x_field} 变化"

        option = {
            "title": {
                "text": final_title,
                "left": "center"
            },
            "tooltip": {
                "trigger": "axis" if chart_type != 'pie' else 'item'
            },
            "legend": {
                "top": "bottom"
            },
            "dataset": {
                "source": dataset_source
            },
            "xAxis": {
                "type": "category", # 默认 X 轴为类目轴
                "name": x_field
            } if chart_type != 'pie' else None,
            "yAxis": {
                "type": "value",
                "name": y_field
            } if chart_type != 'pie' else None,
            "series": []
        }

        # 处理多系列 (Pivot)
        if series_field:
            try:
                # 尝试透视表转换，以便 ECharts 更容易处理多系列
                pivot_df = df.pivot(index=x_field, columns=series_field, values=y_field)
                # 重置索引，第一列是 X，后面是各系列
                pivot_df = pivot_df.reset_index()

                # 更新 dataset source (清理 NaN)
                option['dataset']['source'] = pivot_df.replace({np.nan: None}).to_dict(orient='records')

                # 动态添加 series
                series_names = [c for c in pivot_df.columns if c != x_field]
                for s_name in series_names:
                    option['series'].append({
                        "type": chart_type,
                        "name": str(s_name),
                        "encode": {"x": x_field, "y": s_name}
                    })
            except Exception as e:
                return error_response(f"数据透视失败（可能存在重复的 X+Series 组合）: {str(e)}")
        else:
            # 单系列
            series_cfg = {
                "type": chart_type,
                "encode": {"x": x_field, "y": y_field},
                "name": y_field
            }
            if chart_type == 'pie':
                series_cfg['encode'] = {"itemName": x_field, "value": y_field}
                series_cfg['radius'] = '50%'

            option['series'].append(series_cfg)

        logger.info(f"图表配置生成成功: {chart_type}, 数据点数: {len(dataset_source)}")

        # 使用标准化响应
        return success_response(
            results={"echarts_config": option, "chart_type": chart_type},
            summary=f"图表配置已生成 ({chart_type})"
        )

    except Exception as e:
        return error_response(f"生成图表失败: {str(e)}")

def generate_map(data, map_type="heatmap", title="", name_field="", value_field="", geometry_field="geometry"):
    """
    生成地图可视化配置（Leaflet 地图）

    支持多种地图类型，从知识图谱数据中提取 WKT geometry 并转换为 Leaflet 格式

    返回格式（标准化）:
    {
        "success": True,
        "data": {
            "results": {
                "map_type": "heatmap/marker/circle",
                "heat_data": [[lat, lng, intensity], ...],  # 热力图数据（heatmap）
                "markers": [{"name": "...", "lat": ..., "lng": ..., "value": ...}],  # 标记点数据（marker/circle）
                "bounds": [[minLat, minLng], [maxLat, maxLng]],  # 地图边界
                "center": [lat, lng],  # 地图中心
                "title": "...",
                "value_field": "...",
                "total_points": int
            },
            "metadata": {...},
            "summary": "..."
        }
    }

    Args:
        data: 数据列表（List[Dict]）或数据文件路径（str）
              每条记录必须包含 geometry 字段（WKT格式：POINT (lng lat)）
        map_type: 地图类型
                  - 'heatmap': 热力图（展示数值密度分布）
                  - 'marker': 标记点（展示精确位置和数值）
                  - 'circle': 圆圈标记（圆的大小代表数值大小）
        title: 地图标题
        name_field: 地名字段（如 "city", "区域"）- 可选（marker/circle 时建议提供）
        value_field: 数值字段（如 "受灾人口", "经济损失"）- 必填
        geometry_field: 几何字段名（默认 "geometry"）
    """
    import pandas as pd
    import json
    import os
    import re

    try:
        # 1. 参数验证
        if not value_field:
            return error_response("缺少必填参数: value_field。请指定数值字段。")

        # 验证地图类型
        supported_types = ['heatmap', 'marker', 'circle']
        if map_type not in supported_types:
            return error_response(
                f"不支持的地图类型: {map_type}。支持的类型: {', '.join(supported_types)}"
            )

        # 2. 数据加载
        df = None
        if isinstance(data, str):
            # 首先尝试解析为 JSON 字符串
            try:
                content = json.loads(data)
                if isinstance(content, list):
                    df = pd.DataFrame(content)
                elif isinstance(content, dict) and 'results' in content:
                    df = pd.DataFrame(content['results'])
                else:
                    return error_response("JSON 数据格式错误：需要列表或包含 results 字段的字典")
            except json.JSONDecodeError:
                # 如果不是 JSON 字符串，尝试作为文件路径处理
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
                                if isinstance(content, list):
                                    df = pd.DataFrame(content)
                                elif isinstance(content, dict) and 'results' in content:
                                    df = pd.DataFrame(content['results'])
                                else:
                                    return error_response("文件内容无法解析为表格")
                        except Exception as e:
                            return error_response(f"无法读取数据文件: {str(e)}")
                else:
                    return error_response(f"数据既不是有效的 JSON 字符串，也不是存在的文件路径: {data[:100]}...")
        elif isinstance(data, list):
            df = pd.DataFrame(data)
        else:
            return error_response("数据格式错误：需要列表或文件路径")

        if df is None or df.empty:
            return error_response("数据为空")

        # 3. 验证字段存在性
        columns = df.columns.tolist()
        if value_field not in columns:
            return error_response(f"数值字段 '{value_field}' 在数据中不存在。可用字段: {columns}")
        if geometry_field not in columns:
            return error_response(
                f"几何字段 '{geometry_field}' 在数据中不存在。可用字段: {columns}\n"
                "请确保数据包含 geometry 字段（WKT格式，如 'POINT (lng lat)'）"
            )

        # 4. 解析 WKT geometry 并提取坐标
        def parse_wkt_point(wkt_str):
            """
            解析 WKT POINT 格式: "POINT (lng lat)"
            返回 (lat, lng) 或 None
            """
            if pd.isna(wkt_str) or not isinstance(wkt_str, str):
                return None

            # 正则提取坐标：POINT (lng lat)
            match = re.search(r'POINT\s*\(\s*([\d.+-]+)\s+([\d.+-]+)\s*\)', wkt_str, re.IGNORECASE)
            if match:
                lng = float(match.group(1))
                lat = float(match.group(2))
                return (lat, lng)  # Leaflet 使用 [lat, lng] 顺序
            return None

        # 5. 构建地图数据
        heat_data = []
        markers = []
        valid_count = 0

        # 计算数值范围（用于标准化）
        values = df[value_field].dropna().astype(float)
        if len(values) == 0:
            return error_response(f"{value_field} 字段没有有效的数值数据")

        min_value = float(values.min())
        max_value = float(values.max())

        for idx, row in df.iterrows():
            # 解析坐标
            coords = parse_wkt_point(row[geometry_field])
            if coords is None:
                continue

            lat, lng = coords
            value = float(row[value_field]) if pd.notnull(row[value_field]) else 0

            # 热力图数据: [lat, lng, normalized_intensity]
            # 归一化到 0.1-1.0 范围（避免完全为0的点不显示）
            if max_value > min_value:
                normalized_intensity = 0.1 + 0.9 * (value - min_value) / (max_value - min_value)
            else:
                normalized_intensity = 0.5

            heat_data.append([lat, lng, normalized_intensity])

            # 标记点数据（保留原始值用于显示）
            marker_data = {
                "lat": lat,
                "lng": lng,
                "value": value
            }

            # 添加地名（如果有）
            if name_field and name_field in columns and pd.notnull(row[name_field]):
                marker_data["name"] = str(row[name_field])
            else:
                marker_data["name"] = f"点 {valid_count + 1}"

            # Circle 类型需要半径
            if map_type == 'circle':
                # 根据数值大小计算半径（归一化到 500-5000 米）
                if max_value > min_value:
                    normalized = (value - min_value) / (max_value - min_value)
                    marker_data["radius"] = int(500 + normalized * 4500)
                else:
                    marker_data["radius"] = 2000

            markers.append(marker_data)
            valid_count += 1

        if valid_count == 0:
            return error_response(
                f"没有有效的地理坐标数据。请检查 {geometry_field} 字段是否包含有效的 WKT POINT 格式。"
            )

        # 6. 计算地图边界（用于自动定位）
        lats = [point[0] for point in heat_data]
        lngs = [point[1] for point in heat_data]
        bounds = [
            [min(lats), min(lngs)],  # 西南角
            [max(lats), max(lngs)]   # 东北角
        ]

        # 7. 计算中心点
        center = [
            (min(lats) + max(lats)) / 2,
            (min(lngs) + max(lngs)) / 2
        ]

        # 8. 智能生成标题
        if not title:
            map_type_name = {
                'heatmap': '热力图',
                'marker': '标记点地图',
                'circle': '圆圈标记地图'
            }.get(map_type, '地图')
            title = f"{value_field}分布{map_type_name}"

        # 9. 构建返回数据
        result_data = {
            "map_type": map_type,
            "heat_data": heat_data if map_type == 'heatmap' else [],      # [[lat, lng, intensity], ...]
            "markers": markers if map_type in ['marker', 'circle'] else [],  # [{"name": "...", "lat": ..., "lng": ..., "value": ...}, ...]
            "bounds": bounds,             # [[minLat, minLng], [maxLat, maxLng]]
            "center": center,             # [lat, lng]
            "title": title,
            "value_field": value_field,
            "total_points": valid_count,
            "value_range": {"min": min_value, "max": max_value}
        }

        # 使用标准化响应
        return success_response(
            results=result_data,
            summary=f"地图配置已生成 ({map_type})，共 {valid_count} 个有效数据点"
        )

    except Exception as e:
        logger.error(f"生成地图失败: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return error_response(f"生成地图失败: {str(e)}")

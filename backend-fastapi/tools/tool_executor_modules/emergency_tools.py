# -*- coding: utf-8 -*-
"""
应急决策工具集 - 预案检索、风险评估、响应匹配
"""

import logging
from typing import Optional

from tools.response_builder import error_result, success_result

logger = logging.getLogger(__name__)

# ─── 广西防汛四级响应阈值表 ─────────────────────────────────────
# 基于《广西壮族自治区防汛抗旱应急预案》标准
FLOOD_RISK_THRESHOLDS = {
    "I": {
        "label": "特别重大",
        "color": "red",
        "rainfall_24h": 250,       # mm, ≥ 此值触发
        "water_level_exceed": 3.0, # 超警戒水位 m
        "conditions": [
            "24小时降雨量 ≥ 250mm",
            "主要江河超警戒水位 3.0m 以上",
            "大型水库出现重大险情",
            "多个县级以上城市发生严重内涝",
        ],
    },
    "II": {
        "label": "重大",
        "color": "orange",
        "rainfall_24h": 200,
        "water_level_exceed": 2.0,
        "conditions": [
            "24小时降雨量 ≥ 200mm",
            "主要江河超警戒水位 2.0m 以上",
            "中型以上水库出现较大险情",
            "县级以上城市发生较严重内涝",
        ],
    },
    "III": {
        "label": "较大",
        "color": "yellow",
        "rainfall_24h": 100,
        "water_level_exceed": 1.0,
        "conditions": [
            "24小时降雨量 ≥ 100mm",
            "主要江河超警戒水位 1.0m 以上",
            "小型水库出现险情",
            "部分乡镇发生内涝",
        ],
    },
    "IV": {
        "label": "一般",
        "color": "blue",
        "rainfall_24h": 50,
        "water_level_exceed": 0.5,
        "conditions": [
            "24小时降雨量 ≥ 50mm",
            "主要江河接近或略超警戒水位",
            "小型水库水位偏高",
            "局部地区出现积涝",
        ],
    },
}

# ─── 应急响应措施模板 ───────────────────────────────────────────
RESPONSE_TEMPLATES = {
    "I": {
        "response_name": "I级应急响应",
        "command_authority": "自治区防汛抗旱指挥部总指挥",
        "key_actions": [
            "启动自治区防汛I级应急响应",
            "自治区防指全体成员到岗，24小时值班",
            "请求国家防总和解放军/武警支援",
            "组织危险区域群众紧急转移安置",
            "启用全部防洪工程和应急抢险队伍",
            "实施交通管制和重点区域封闭管理",
            "启动救灾物资紧急调运",
            "开放全部应急避难场所",
        ],
        "time_requirements": [
            "接到预警后1小时内启动响应",
            "2小时内完成危险区域人员转移",
            "每1小时上报一次灾情信息",
        ],
        "resource_mobilization": [
            "调动省级防汛抢险专业队伍",
            "调配省级救灾物资储备",
            "协调驻桂部队和武警参与抢险",
        ],
    },
    "II": {
        "response_name": "II级应急响应",
        "command_authority": "自治区防汛抗旱指挥部副总指挥",
        "key_actions": [
            "启动自治区防汛II级应急响应",
            "自治区防指主要成员到岗值守",
            "加强气象水文监测和预报预警",
            "组织受威胁区域群众有序转移",
            "加强重要堤防和水库巡查防守",
            "预置抢险物资和救援力量",
            "发布公众防灾避险提示",
        ],
        "time_requirements": [
            "接到预警后2小时内启动响应",
            "4小时内完成重点区域人员转移",
            "每2小时上报一次灾情信息",
        ],
        "resource_mobilization": [
            "调动市级防汛抢险队伍",
            "启用市级救灾物资储备",
            "协调消防救援力量",
        ],
    },
    "III": {
        "response_name": "III级应急响应",
        "command_authority": "自治区防汛抗旱指挥部秘书长",
        "key_actions": [
            "启动自治区防汛III级应急响应",
            "相关成员单位加强值班",
            "密切监视雨情水情发展",
            "指导受威胁地区做好防范准备",
            "检查加固防洪工程薄弱环节",
            "通知相关地区做好转移准备",
        ],
        "time_requirements": [
            "接到预警后4小时内启动响应",
            "6小时内完成隐患排查",
            "每3小时上报一次灾情信息",
        ],
        "resource_mobilization": [
            "县级防汛抢险队伍待命",
            "核查县级救灾物资储备",
        ],
    },
    "IV": {
        "response_name": "IV级应急响应",
        "command_authority": "自治区防汛抗旱指挥部办公室主任",
        "key_actions": [
            "启动自治区防汛IV级应急响应",
            "加强值班和信息报送",
            "关注天气形势和水情变化",
            "提醒相关地区注意防范",
            "检查防洪排涝设施运行状况",
        ],
        "time_requirements": [
            "接到预警后6小时内启动响应",
            "每6小时上报一次灾情信息",
        ],
        "resource_mobilization": [
            "乡镇级抢险队伍待命",
        ],
    },
}


def query_emergency_plan(
    query: str,
    plan_type: Optional[str] = None,
    top_k: int = 5,
) -> "ToolExecutionResult":
    """
    检索应急预案知识库。

    通过向量库进行语义搜索，返回最相关的预案内容片段。
    向量库为空或未初始化时返回友好提示。
    """
    if not query or not query.strip():
        return error_result("缺少必填参数: query", tool_name="query_emergency_plan")

    top_k = max(1, min(top_k, 20))

    try:
        from vector_store.retriever import VectorRetriever

        retriever = VectorRetriever(collection_name="emergency_plans")

        # 构建元数据过滤条件
        filters = {}
        if plan_type:
            filters["plan_type"] = plan_type

        results = retriever.hybrid_search(
            query=query.strip(),
            keyword=None,
            top_k=top_k,
            filters=filters if filters else None,
        )

        if not results:
            return success_result(
                content={
                    "query": query,
                    "plan_type": plan_type,
                    "results": [],
                    "total": 0,
                    "message": "未找到相关预案内容。预案库可能尚未建立或无匹配条目。",
                },
                summary="未找到相关预案内容",
                output_type="json",
                tool_name="query_emergency_plan",
                llm_hint="未检索到相关预案，可尝试调整查询关键词或告知用户预案库暂无相关数据。",
            )

        # 格式化结果
        formatted = []
        for r in results:
            item = {
                "text": r.get("text", ""),
                "similarity": round(r.get("similarity", 0), 4),
                "metadata": r.get("metadata", {}),
            }
            formatted.append(item)

        return success_result(
            content={
                "query": query,
                "plan_type": plan_type,
                "results": formatted,
                "total": len(formatted),
            },
            summary=f"检索到 {len(formatted)} 条相关预案内容",
            output_type="json",
            tool_name="query_emergency_plan",
            llm_hint="请基于检索到的预案内容回答用户问题，注意引用具体条款。",
        )

    except Exception as e:
        err_msg = str(e)
        # 向量库未初始化或集合不存在时优雅降级
        if any(kw in err_msg.lower() for kw in [
            "collection", "not found", "not exist", "not initialized",
            "connection", "没有找到", "未初始化",
        ]):
            logger.warning(f"预案向量库不可用: {err_msg}")
            return success_result(
                content={
                    "query": query,
                    "plan_type": plan_type,
                    "results": [],
                    "total": 0,
                    "message": "预案知识库尚未建立，暂无法进行预案检索。请联系管理员导入预案数据。",
                },
                summary="预案知识库尚未建立",
                output_type="json",
                tool_name="query_emergency_plan",
                llm_hint="预案向量库未建立，无法检索。请基于通用知识回答，并提示用户预案库需要建设。",
            )
        logger.error(f"预案检索失败: {err_msg}")
        return error_result(f"预案检索失败: {err_msg}", tool_name="query_emergency_plan")


def assess_flood_risk(
    location: str,
    rainfall_24h: Optional[float] = None,
    water_level: Optional[float] = None,
    warning_level: Optional[float] = None,
    forecast_rainfall: Optional[float] = None,
) -> "ToolExecutionResult":
    """
    根据气象/水文数据评估洪涝风险等级（I-IV级）。

    内置广西省防汛四级响应标准阈值表，结合输入数据计算风险矩阵。
    """
    if not location or not location.strip():
        return error_result("缺少必填参数: location", tool_name="assess_flood_risk")

    # 至少需要一项数据输入
    has_data = any(v is not None for v in [rainfall_24h, water_level, forecast_rainfall])
    if not has_data:
        return error_result(
            "至少需要提供 rainfall_24h、water_level、forecast_rainfall 中的一项数据",
            tool_name="assess_flood_risk",
        )

    try:
        # 计算超警戒水位
        water_level_exceed = None
        if water_level is not None and warning_level is not None:
            water_level_exceed = water_level - warning_level

        # 使用有效降雨量（取实际和预报中的较大值）
        effective_rainfall = rainfall_24h
        if forecast_rainfall is not None:
            if effective_rainfall is None:
                effective_rainfall = forecast_rainfall
            else:
                effective_rainfall = max(effective_rainfall, forecast_rainfall)

        # 从高到低匹配风险等级
        matched_level = None
        risk_factors = []

        for level in ["I", "II", "III", "IV"]:
            threshold = FLOOD_RISK_THRESHOLDS[level]
            level_matched = False

            if effective_rainfall is not None and effective_rainfall >= threshold["rainfall_24h"]:
                risk_factors.append(
                    f"降雨量 {effective_rainfall}mm ≥ {level}级阈值 {threshold['rainfall_24h']}mm"
                )
                level_matched = True

            if water_level_exceed is not None and water_level_exceed >= threshold["water_level_exceed"]:
                risk_factors.append(
                    f"超警戒水位 {water_level_exceed:.2f}m ≥ {level}级阈值 {threshold['water_level_exceed']}m"
                )
                level_matched = True

            if level_matched and matched_level is None:
                matched_level = level

        # 未达到任何阈值
        if matched_level is None:
            return success_result(
                content={
                    "location": location,
                    "risk_level": None,
                    "risk_label": "未达到响应标准",
                    "input_data": {
                        "rainfall_24h": rainfall_24h,
                        "water_level": water_level,
                        "warning_level": warning_level,
                        "water_level_exceed": water_level_exceed,
                        "forecast_rainfall": forecast_rainfall,
                    },
                    "risk_factors": [],
                    "assessment": "当前数据未达到任何级别的防汛应急响应启动标准，建议持续监测。",
                    "thresholds": FLOOD_RISK_THRESHOLDS,
                },
                summary=f"{location} 当前洪涝风险未达到响应标准",
                output_type="json",
                tool_name="assess_flood_risk",
            )

        threshold_info = FLOOD_RISK_THRESHOLDS[matched_level]

        return success_result(
            content={
                "location": location,
                "risk_level": matched_level,
                "risk_label": threshold_info["label"],
                "risk_color": threshold_info["color"],
                "input_data": {
                    "rainfall_24h": rainfall_24h,
                    "water_level": water_level,
                    "warning_level": warning_level,
                    "water_level_exceed": water_level_exceed,
                    "forecast_rainfall": forecast_rainfall,
                },
                "risk_factors": risk_factors,
                "trigger_conditions": threshold_info["conditions"],
                "assessment": (
                    f"{location} 当前评估为 {matched_level} 级（{threshold_info['label']}）洪涝风险，"
                    f"建议启动{matched_level}级防汛应急响应。"
                ),
                "thresholds": FLOOD_RISK_THRESHOLDS,
            },
            summary=f"{location} 洪涝风险评估: {matched_level}级（{threshold_info['label']}）",
            output_type="json",
            tool_name="assess_flood_risk",
            llm_hint=(
                f"风险等级为{matched_level}级（{threshold_info['label']}），"
                f"请结合响应措施给出具体建议。"
            ),
        )

    except Exception as e:
        logger.error(f"风险评估失败: {e}")
        return error_result(f"风险评估失败: {str(e)}", tool_name="assess_flood_risk")


def match_emergency_response(
    risk_level: str,
    disaster_type: str,
    affected_area: Optional[str] = None,
) -> "ToolExecutionResult":
    """
    根据风险等级和灾害类型匹配应急响应措施。

    先检索相关预案条款，再结合内置响应模板，输出结构化的应急措施。
    """
    if not risk_level or not risk_level.strip():
        return error_result("缺少必填参数: risk_level", tool_name="match_emergency_response")
    if not disaster_type or not disaster_type.strip():
        return error_result("缺少必填参数: disaster_type", tool_name="match_emergency_response")

    risk_level = risk_level.strip().upper()
    if risk_level not in RESPONSE_TEMPLATES:
        return error_result(
            f"无效的风险等级: {risk_level}，有效值为 I/II/III/IV",
            tool_name="match_emergency_response",
        )

    try:
        # 尝试检索相关预案条款
        plan_results = []
        plan_message = ""
        try:
            plan_query = f"{risk_level}级应急响应 {disaster_type}"
            if affected_area:
                plan_query += f" {affected_area}"

            plan_result = query_emergency_plan(query=plan_query, top_k=3)
            if plan_result.success and isinstance(plan_result.content, dict):
                plan_results = plan_result.content.get("results", [])
                plan_message = plan_result.content.get("message", "")
        except Exception as e:
            logger.warning(f"检索预案时出错（降级处理）: {e}")
            plan_message = "预案检索不可用，使用内置响应模板。"

        # 获取内置响应模板
        template = RESPONSE_TEMPLATES[risk_level]
        threshold_info = FLOOD_RISK_THRESHOLDS[risk_level]

        # 构建完整的响应措施
        response_data = {
            "risk_level": risk_level,
            "risk_label": threshold_info["label"],
            "disaster_type": disaster_type,
            "affected_area": affected_area,
            "response": {
                "name": template["response_name"],
                "command_authority": template["command_authority"],
                "key_actions": template["key_actions"],
                "time_requirements": template["time_requirements"],
                "resource_mobilization": template["resource_mobilization"],
            },
            "trigger_conditions": threshold_info["conditions"],
            "plan_references": [
                {"text": r.get("text", ""), "similarity": r.get("similarity", 0)}
                for r in plan_results
            ],
            "plan_note": plan_message if plan_message else None,
        }

        area_desc = f"（{affected_area}）" if affected_area else ""
        return success_result(
            content=response_data,
            summary=f"已匹配{risk_level}级（{threshold_info['label']}）{disaster_type}应急响应措施{area_desc}",
            output_type="json",
            tool_name="match_emergency_response",
            llm_hint=(
                f"已匹配到{risk_level}级应急响应措施，请按照职责分工、关键行动、时间要求的顺序"
                f"向用户呈现，并结合预案条款（如有）给出针对性建议。"
            ),
        )

    except Exception as e:
        logger.error(f"响应匹配失败: {e}")
        return error_result(f"响应匹配失败: {str(e)}", tool_name="match_emergency_response")


def create_risk_map(
    locations_data,
    title: str = "",
    disaster_type: str = "洪涝",
    session_id=None,
) -> "ToolExecutionResult":
    """
    批量风险评估 + 自动生成风险地图。

    对每个地点调用 assess_flood_risk 获取风险等级，然后自动生成带颜色标记的风险地图。

    Args:
        locations_data: 含 location/geometry + 气象水文数据的 JSON/文件
        title: 地图标题
        disaster_type: 灾害类型（默认"洪涝"）
        session_id: 会话 ID
    """
    from tools.visualization_artifact_manager import get_visualization_artifact_manager
    from tools.tool_executor_modules.visualization_tools import _load_dataframe, _parse_geometry
    import pandas as pd

    RISK_COLORS = {
        "I": "#d32f2f",
        "II": "#ff9800",
        "III": "#fdd835",
        "IV": "#1976d2",
    }
    RISK_LABELS = {
        "I": "特别重大",
        "II": "重大",
        "III": "较大",
        "IV": "一般",
    }

    try:
        if not locations_data:
            return error_result("缺少必填参数: locations_data", tool_name="create_risk_map")

        df, err = _load_dataframe(locations_data, "create_risk_map")
        if err:
            return err

        columns = df.columns.tolist()

        # 校验必要字段
        if "location" not in columns:
            return error_result(
                f"数据缺少 'location' 字段。可用字段: {columns}",
                tool_name="create_risk_map",
            )

        geometry_field = "geometry"
        if geometry_field not in columns:
            # 无 geometry 字段时，后续逐行通过 geocode 降级获取坐标，不直接报错
            logger.info(f"数据无 geometry 字段，将通过 geocode 降级解析坐标。可用字段: {columns}")

        # 气象/水文数据字段
        data_fields = ["rainfall_24h", "water_level", "warning_level", "forecast_rainfall"]
        has_any_data = any(f in columns for f in data_fields)
        if not has_any_data:
            return error_result(
                f"数据缺少气象/水文字段。需要至少一项: {data_fields}。可用字段: {columns}",
                tool_name="create_risk_map",
            )

        markers = []
        assessment_summary = {"I": 0, "II": 0, "III": 0, "IV": 0}
        detailed_results = []

        for idx, row in df.iterrows():
            location = str(row["location"])
            geom = _parse_geometry(row.get(geometry_field))
            if geom is None:
                # 降级：尝试通过 guangxi-geodata Skill 内嵌数据解析坐标
                try:
                    import subprocess, sys as _sys, json as _json, os as _os
                    _skill_script = _os.path.join(
                        _os.path.dirname(__file__), "..", "..", "agents", "skills",
                        "guangxi-geodata", "scripts", "geocode.py",
                    )
                    _skill_script = _os.path.normpath(_skill_script)
                    if _os.path.exists(_skill_script):
                        _proc = subprocess.run(
                            [_sys.executable, _skill_script, "--location", location],
                            capture_output=True, text=True, timeout=5,
                        )
                        if _proc.returncode == 0 and _proc.stdout.strip():
                            _geo_r = _json.loads(_proc.stdout)
                            if _geo_r.get("found"):
                                geom = {"centroid": [_geo_r["lat"], _geo_r["lng"]]}
                                logger.info(f"geocode 降级成功: {location} → ({_geo_r['lat']}, {_geo_r['lng']})")
                except Exception as _ge:
                    logger.debug(f"geocode 降级异常 ({location}): {_ge}")
            if geom is None:
                logger.warning(f"跳过 {location}: 无法解析几何数据（geocode 降级也失败）")
                continue

            centroid = geom["centroid"]  # [lat, lng]

            # 构建 assess_flood_risk 参数
            risk_kwargs = {"location": location}
            for field in data_fields:
                if field in columns and pd.notnull(row.get(field)):
                    risk_kwargs[field] = float(row[field])

            # 调用风险评估
            risk_result = assess_flood_risk(**risk_kwargs)
            risk_content = risk_result.content if risk_result.success else {}

            risk_level = risk_content.get("risk_level")
            risk_label = risk_content.get("risk_label", "未知")
            risk_factors = risk_content.get("risk_factors", [])
            assessment = risk_content.get("assessment", "")
            risk_color = RISK_COLORS.get(risk_level, "#999999")

            if risk_level and risk_level in assessment_summary:
                assessment_summary[risk_level] += 1

            marker = {
                "lat": centroid[0],
                "lng": centroid[1],
                "name": location,
                "value": 0,
                "risk_level": risk_level or "无",
                "risk_label": risk_label,
                "risk_color": risk_color,
                "risk_factors": risk_factors,
                "assessment": assessment,
            }
            markers.append(marker)

            detailed_results.append({
                "location": location,
                "risk_level": risk_level,
                "risk_label": risk_label,
                "risk_factors": risk_factors,
                "assessment": assessment,
            })

        if not markers:
            return error_result("没有有效的评估数据", tool_name="create_risk_map")

        # 计算 bounds
        lats = [m["lat"] for m in markers]
        lngs = [m["lng"] for m in markers]
        bounds = [[min(lats), min(lngs)], [max(lats), max(lngs)]]
        center = [(min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2]

        if not title:
            title = f"{disaster_type}风险评估地图"

        # 构建风险图例
        risk_legend = {}
        for level in ["I", "II", "III", "IV"]:
            risk_legend[level] = {
                "color": RISK_COLORS[level],
                "label": RISK_LABELS[level],
            }

        map_data = {
            "map_type": "risk",
            "markers": markers,
            "bounds": bounds,
            "center": center,
            "title": title,
            "total_points": len(markers),
            "risk_legend": risk_legend,
            "assessment_summary": assessment_summary,
            "disaster_type": disaster_type,
        }

        manager = get_visualization_artifact_manager()
        record = manager.create_map(
            session_id=session_id,
            map_data=map_data,
            map_type="risk",
            title=title,
        )

        logger.info(f"风险地图已持久化: artifact_id={record.artifact_id}, points={len(markers)}")

        # 构建评估摘要
        summary_parts = []
        for level in ["I", "II", "III", "IV"]:
            count = assessment_summary[level]
            if count > 0:
                summary_parts.append(f"{level}级({RISK_LABELS[level]}):{count}个")

        return success_result(
            content={
                "artifact_id": record.artifact_id,
                "viz_type": "map",
                "title": title,
                "preview": {
                    "map_type": "risk",
                    "total_points": len(markers),
                    "center": center,
                },
                "assessment_summary": assessment_summary,
                "detailed_results": detailed_results,
            },
            summary=f"风险地图已生成：{title}（{len(markers)}个监测点，{', '.join(summary_parts) or '无风险'}）",
            output_type="map",
            tool_name="create_risk_map",
            llm_hint=f"在 <final_answer> 中插入 [viz:{record.artifact_id}] 来展示此风险地图。请结合评估结果给出决策建议。",
        )

    except Exception as e:
        logger.error(f"生成风险地图失败: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return error_result(f"生成风险地图失败: {str(e)}", tool_name="create_risk_map")

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
assess_flood_risk.py - 洪涝风险等级评估

基于《广西壮族自治区防汛抗旱应急预案》四级响应标准，
根据降雨量和水位数据计算风险等级（I-IV）及应急响应措施。

用法:
  python scripts/assess_flood_risk.py --location "南宁市" --rainfall 180
  python scripts/assess_flood_risk.py --location "桂林市" --rainfall 120 --water-level 148.5 --warning-level 146.0
  python scripts/assess_flood_risk.py --batch '[{"location":"南宁市","rainfall_24h":180},{"location":"桂林市","rainfall_24h":90}]'
"""

import sys
import json
import argparse

# ─── 广西防汛四级响应阈值表 ────────────────────────────────────────
# 基于《广西壮族自治区防汛抗旱应急预案》标准
FLOOD_RISK_THRESHOLDS = {
    "I": {
        "label": "特别重大",
        "color": "red",
        "rainfall_24h": 250,
        "water_level_exceed": 3.0,
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

# ─── 应急响应措施模板 ──────────────────────────────────────────────
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


def assess_single(
    location,
    rainfall_24h=None,
    water_level=None,
    warning_level=None,
    forecast_rainfall=None,
):
    """单点风险评估，返回结果 dict。"""
    # 计算超警戒水位
    water_level_exceed = None
    if water_level is not None and warning_level is not None:
        water_level_exceed = round(water_level - warning_level, 3)

    # 有效降雨量：取实测与预报中的较大值
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
                f"超警戒水位 {water_level_exceed}m ≥ {level}级阈值 {threshold['water_level_exceed']}m"
            )
            level_matched = True

        if level_matched and matched_level is None:
            matched_level = level

    if matched_level is None:
        return {
            "location": location,
            "risk_level": None,
            "risk_label": "未达到响应标准",
            "risk_color": "green",
            "input_data": {
                "rainfall_24h": rainfall_24h,
                "water_level": water_level,
                "warning_level": warning_level,
                "water_level_exceed": water_level_exceed,
                "forecast_rainfall": forecast_rainfall,
                "effective_rainfall": effective_rainfall,
            },
            "risk_factors": [],
            "assessment": "当前数据未达到任何级别的防汛应急响应启动标准，建议持续监测。",
            "response": None,
        }

    t = FLOOD_RISK_THRESHOLDS[matched_level]
    tmpl = RESPONSE_TEMPLATES[matched_level]

    return {
        "location": location,
        "risk_level": matched_level,
        "risk_label": t["label"],
        "risk_color": t["color"],
        "input_data": {
            "rainfall_24h": rainfall_24h,
            "water_level": water_level,
            "warning_level": warning_level,
            "water_level_exceed": water_level_exceed,
            "forecast_rainfall": forecast_rainfall,
            "effective_rainfall": effective_rainfall,
        },
        "risk_factors": risk_factors,
        "trigger_conditions": t["conditions"],
        "assessment": (
            f"{location} 当前评估为 {matched_level} 级（{t['label']}）洪涝风险，"
            f"建议启动{matched_level}级防汛应急响应。"
        ),
        "response": {
            "name": tmpl["response_name"],
            "command_authority": tmpl["command_authority"],
            "key_actions": tmpl["key_actions"],
            "time_requirements": tmpl["time_requirements"],
            "resource_mobilization": tmpl["resource_mobilization"],
        },
    }


def main():
    parser = argparse.ArgumentParser(description="洪涝风险等级评估")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--location", help="地点名称，如'南宁市'")
    group.add_argument(
        "--batch",
        help=(
            "批量评估，JSON 数组字符串，每项含 location 和至少一项数据字段。"
            "例: '[{\"location\":\"南宁市\",\"rainfall_24h\":180}]'"
        ),
    )
    parser.add_argument("--rainfall", type=float, dest="rainfall_24h",
                        help="24小时实际降雨量（mm）")
    parser.add_argument("--forecast-rainfall", type=float,
                        help="未来24小时预报降雨量（mm）")
    parser.add_argument("--water-level", type=float,
                        help="当前水位（m）")
    parser.add_argument("--warning-level", type=float,
                        help="警戒水位（m），与 --water-level 配合计算超警幅度")
    args = parser.parse_args()

    if args.batch:
        try:
            items = json.loads(args.batch)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"--batch JSON 解析失败: {e}"}, ensure_ascii=False))
            sys.exit(1)

        if not isinstance(items, list):
            print(json.dumps({"error": "--batch 必须是 JSON 数组"}, ensure_ascii=False))
            sys.exit(1)

        results = []
        summary = {"I": 0, "II": 0, "III": 0, "IV": 0, "无": 0}

        for item in items:
            if not isinstance(item, dict) or "location" not in item:
                results.append({"error": f"条目缺少 location 字段: {item}"})
                continue
            r = assess_single(
                location=item["location"],
                rainfall_24h=item.get("rainfall_24h"),
                water_level=item.get("water_level"),
                warning_level=item.get("warning_level"),
                forecast_rainfall=item.get("forecast_rainfall"),
            )
            results.append(r)
            lvl = r.get("risk_level") or "无"
            if lvl in summary:
                summary[lvl] += 1

        output = {
            "total": len(results),
            "summary": summary,
            "results": results,
            "usage_hint": (
                "results 中每项含 risk_level/risk_color/risk_factors，"
                "可配合 geocode.py 输出的 wkt 字段构造 create_risk_map 所需数据"
            ),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))

    else:
        has_data = any(v is not None for v in [
            args.rainfall_24h, args.water_level, args.forecast_rainfall
        ])
        if not has_data:
            print(json.dumps({
                "error": "至少需要提供 --rainfall、--water-level、--forecast-rainfall 中的一项"
            }, ensure_ascii=False))
            sys.exit(1)

        r = assess_single(
            location=args.location,
            rainfall_24h=args.rainfall_24h,
            water_level=args.water_level,
            warning_level=args.warning_level,
            forecast_rainfall=args.forecast_rainfall,
        )
        print(json.dumps(r, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

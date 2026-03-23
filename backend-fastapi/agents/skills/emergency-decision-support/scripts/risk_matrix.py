#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
risk_matrix.py - 风险矩阵计算

基于多维度数据和广西防汛四级响应标准，计算综合风险等级。
用法:
  python scripts/risk_matrix.py --location "南宁市" --rainfall 200 --water-level 79.0 --warning-level 77.0
"""

import sys
import json
import argparse


# 广西防汛四级响应阈值
THRESHOLDS = {
    "I":   {"rainfall": 250, "exceed_warning": 3.0, "population": 500000, "dam_risk": "high"},
    "II":  {"rainfall": 200, "exceed_warning": 2.0, "population": 100000, "dam_risk": "medium"},
    "III": {"rainfall": 100, "exceed_warning": 1.0, "population": 50000,  "dam_risk": "low"},
    "IV":  {"rainfall": 50,  "exceed_warning": 0.5, "population": 10000,  "dam_risk": "none"},
}

LEVEL_LABELS = {"I": "特别重大", "II": "重大", "III": "较大", "IV": "一般"}
LEVEL_COLORS = {"I": "red", "II": "orange", "III": "yellow", "IV": "blue"}

DAM_RISK_SCORE = {"none": 0, "low": 1, "medium": 2, "high": 3}


def compute_risk(args):
    """多维度风险矩阵计算。"""
    # 各维度评分 (0-3, 对应 IV-I)
    scores = {}
    details = {}

    # 降雨量维度
    effective_rainfall = args.rainfall
    if args.forecast_rainfall is not None:
        if effective_rainfall is None:
            effective_rainfall = args.forecast_rainfall
        else:
            effective_rainfall = max(effective_rainfall, args.forecast_rainfall)

    if effective_rainfall is not None:
        if effective_rainfall >= 250:
            scores["rainfall"] = 3
        elif effective_rainfall >= 200:
            scores["rainfall"] = 2
        elif effective_rainfall >= 100:
            scores["rainfall"] = 1
        elif effective_rainfall >= 50:
            scores["rainfall"] = 0
        else:
            scores["rainfall"] = -1  # 未达标
        details["rainfall"] = f"{effective_rainfall}mm"

    # 水位维度
    if args.water_level is not None and args.warning_level is not None:
        exceed = args.water_level - args.warning_level
        if exceed >= 3.0:
            scores["water_level"] = 3
        elif exceed >= 2.0:
            scores["water_level"] = 2
        elif exceed >= 1.0:
            scores["water_level"] = 1
        elif exceed >= 0.5:
            scores["water_level"] = 0
        else:
            scores["water_level"] = -1
        details["water_level"] = f"超警 {exceed:.2f}m"

    # 受影响人口维度
    if args.affected_population is not None:
        pop = args.affected_population
        if pop >= 500000:
            scores["population"] = 3
        elif pop >= 100000:
            scores["population"] = 2
        elif pop >= 50000:
            scores["population"] = 1
        elif pop >= 10000:
            scores["population"] = 0
        else:
            scores["population"] = -1
        details["population"] = f"{pop}人"

    # 水库风险维度
    if args.dam_risk is not None:
        scores["dam_risk"] = DAM_RISK_SCORE.get(args.dam_risk, -1)
        details["dam_risk"] = args.dam_risk

    if not scores:
        return {
            "location": args.location,
            "risk_level": None,
            "error": "无有效数据输入，无法计算风险",
        }

    # 综合评估：取最高维度分数（最不利原则）
    valid_scores = {k: v for k, v in scores.items() if v >= 0}
    if not valid_scores:
        return {
            "location": args.location,
            "risk_level": None,
            "risk_label": "未达标",
            "scores": scores,
            "details": details,
            "assessment": "所有维度均未达到IV级响应标准",
        }

    max_score = max(valid_scores.values())
    max_dimension = [k for k, v in valid_scores.items() if v == max_score][0]

    level_map = {3: "I", 2: "II", 1: "III", 0: "IV"}
    risk_level = level_map.get(max_score, "IV")

    return {
        "location": args.location,
        "risk_level": risk_level,
        "risk_label": LEVEL_LABELS[risk_level],
        "risk_color": LEVEL_COLORS[risk_level],
        "dominant_factor": max_dimension,
        "dimension_scores": scores,
        "dimension_details": details,
        "thresholds": THRESHOLDS,
        "assessment": (
            f"{args.location} 综合风险等级: {risk_level}级（{LEVEL_LABELS[risk_level]}），"
            f"主要驱动因素: {max_dimension}（{details.get(max_dimension, '')}）"
        ),
    }


def main():
    parser = argparse.ArgumentParser(description="风险矩阵计算")
    parser.add_argument("--location", required=True, help="地点")
    parser.add_argument("--rainfall", type=float, default=None, help="24小时降雨量(mm)")
    parser.add_argument("--forecast-rainfall", type=float, default=None, help="预报降雨量(mm)")
    parser.add_argument("--water-level", type=float, default=None, help="当前水位(m)")
    parser.add_argument("--warning-level", type=float, default=None, help="警戒水位(m)")
    parser.add_argument("--affected-population", type=int, default=None, help="受影响人口")
    parser.add_argument("--dam-risk", default=None, choices=["none", "low", "medium", "high"], help="水库风险")
    args = parser.parse_args()

    result = compute_risk(args)
    json.dump({"success": True, "data": result}, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
match_response.py - 响应匹配

根据风险等级和灾害类型，返回推荐预案与可执行行动清单的组合结果。
本脚本是对原 match_emergency_response 工具语义的 1:1 Skill 化封装。

用法:
  python scripts/match_response.py --risk-level III --disaster-type 洪涝 --affected-area 南宁市
"""

import sys
import json
import argparse

from plan_recommend import BUILTIN_PLANS, recommend_plan
from action_checklist import generate_checklist


def match_response(args):
    risk_level = args.risk_level.upper()
    if risk_level not in BUILTIN_PLANS:
        return {"success": False, "error": f"无效风险等级: {risk_level}，有效值: I/II/III/IV"}

    plan_result = recommend_plan(
        type("PlanArgs", (), {
            "risk_level": risk_level,
            "disaster_type": args.disaster_type,
            "location": args.affected_area,
            "top_k": args.top_k,
        })()
    )

    checklist_result = generate_checklist(
        type("ChecklistArgs", (), {
            "risk_level": risk_level,
            "disaster_type": args.disaster_type,
            "affected_area": args.affected_area,
            "format": "json",
        })()
    )

    return {
        "risk_level": risk_level,
        "disaster_type": args.disaster_type,
        "affected_area": args.affected_area,
        "matched_plan": plan_result.get("builtin_plan") if isinstance(plan_result, dict) else None,
        "vector_search_results": plan_result.get("vector_search_results", []) if isinstance(plan_result, dict) else [],
        "plan_source": plan_result.get("source", "builtin") if isinstance(plan_result, dict) else "builtin",
        "checklist": checklist_result,
        "summary": f"已为 {args.affected_area or '目标区域'} 匹配 {risk_level} 级{args.disaster_type}响应方案，并生成行动清单",
    }


def main():
    parser = argparse.ArgumentParser(description="响应匹配")
    parser.add_argument("--risk-level", required=True, help="风险等级 I/II/III/IV")
    parser.add_argument("--disaster-type", default="洪涝", help="灾害类型")
    parser.add_argument("--affected-area", default=None, help="受影响区域")
    parser.add_argument("--top-k", type=int, default=5, help="预案检索返回条目数")
    args = parser.parse_args()

    result = match_response(args)
    json.dump({"success": True, "data": result}, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
plan_recommend.py - 预案推荐

根据风险等级和灾害类型，检索并推荐最相关的预案条款。
当向量库不可用时，返回内置的基本响应框架。
用法:
  python scripts/plan_recommend.py --risk-level III --disaster-type 洪涝 --location 南宁市
"""

import sys
import json
import argparse


# 内置预案框架（向量库不可用时的降级方案）
BUILTIN_PLANS = {
    "I": {
        "response_level": "I级（特别重大）",
        "activation_conditions": [
            "24小时降雨量 ≥ 250mm 且仍有持续强降雨",
            "主要江河超警戒水位 3.0m 以上且继续上涨",
            "大型水库出现重大险情或溃坝风险",
            "多个县级以上城市发生严重内涝",
        ],
        "core_measures": [
            "自治区防指总指挥主持会商，全体成员到岗",
            "请求国家防总支援和解放军/武警增援",
            "全面启动抢险救援力量",
            "危险区域群众全部紧急转移",
            "交通管制和重点区域封闭",
            "开放全部应急避难场所",
        ],
    },
    "II": {
        "response_level": "II级（重大）",
        "activation_conditions": [
            "24小时降雨量 ≥ 200mm",
            "主要江河超警戒水位 2.0m 以上",
            "中型以上水库出现较大险情",
        ],
        "core_measures": [
            "自治区防指副总指挥主持会商",
            "加强气象水文监测预报",
            "受威胁区域群众有序转移",
            "重要堤防和水库加强巡查",
            "预置抢险物资和救援力量",
        ],
    },
    "III": {
        "response_level": "III级（较大）",
        "activation_conditions": [
            "24小时降雨量 ≥ 100mm",
            "主要江河超警戒水位 1.0m 以上",
            "小型水库出现险情",
        ],
        "core_measures": [
            "自治区防指秘书长主持会商",
            "密切监视雨情水情",
            "指导地方做好防范",
            "检查加固薄弱环节",
            "通知相关地区做好转移准备",
        ],
    },
    "IV": {
        "response_level": "IV级（一般）",
        "activation_conditions": [
            "24小时降雨量 ≥ 50mm",
            "主要江河接近或略超警戒水位",
        ],
        "core_measures": [
            "加强值班和信息报送",
            "关注天气和水情变化",
            "提醒相关地区注意防范",
            "检查防洪排涝设施",
        ],
    },
}


def recommend_plan(args):
    """推荐预案。优先从向量库检索，不可用时使用内置框架。"""
    risk_level = args.risk_level.upper()
    if risk_level not in BUILTIN_PLANS:
        return {"success": False, "error": f"无效风险等级: {risk_level}，有效值: I/II/III/IV"}

    result = {
        "risk_level": risk_level,
        "disaster_type": args.disaster_type,
        "location": args.location,
        "vector_search_results": [],
        "builtin_plan": BUILTIN_PLANS[risk_level],
        "source": "builtin",
    }

    # 尝试从向量库检索
    try:
        sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[3]))
        from vector_store.retriever import VectorRetriever

        retriever = VectorRetriever(collection_name="emergency_plans")
        query = f"{risk_level}级应急响应 {args.disaster_type}"
        if args.location:
            query += f" {args.location}"

        search_results = retriever.hybrid_search(query=query, top_k=args.top_k)

        if search_results:
            result["vector_search_results"] = [
                {
                    "text": r.get("text", ""),
                    "similarity": round(r.get("similarity", 0), 4),
                    "metadata": r.get("metadata", {}),
                }
                for r in search_results
            ]
            result["source"] = "vector_db + builtin"
    except Exception as e:
        result["vector_search_note"] = f"向量库检索不可用（{type(e).__name__}），使用内置预案框架"

    return result


def main():
    parser = argparse.ArgumentParser(description="预案推荐")
    parser.add_argument("--risk-level", required=True, help="风险等级 I/II/III/IV")
    parser.add_argument("--disaster-type", default="洪涝", help="灾害类型")
    parser.add_argument("--location", default=None, help="地点")
    parser.add_argument("--top-k", type=int, default=5, help="返回条目数")
    args = parser.parse_args()

    result = recommend_plan(args)
    json.dump({"success": True, "data": result}, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

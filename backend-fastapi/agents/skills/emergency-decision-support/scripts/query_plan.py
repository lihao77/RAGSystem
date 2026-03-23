#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
query_plan.py - 应急预案向量检索

通过向量库语义搜索返回最相关的预案内容片段。
向量库不可用时优雅降级返回提示。

用法:
  python query_plan.py --query "三级防汛应急响应启动条件"
  python query_plan.py --query "台风应急响应" --plan-type 台风 --top-k 3
"""

import sys
import os
import json
import argparse


def _try_vector_search(query, plan_type=None, top_k=5):
    """尝试调用向量库检索，失败返回 None。"""
    try:
        # 尝试导入后端向量检索模块
        backend_root = os.path.normpath(os.path.join(
            os.path.dirname(__file__), "..", "..", "..",
        ))
        if backend_root not in sys.path:
            sys.path.insert(0, backend_root)

        from vector_store.retriever import VectorRetriever
        retriever = VectorRetriever(collection_name="emergency_plans")

        filters = {}
        if plan_type:
            filters["plan_type"] = plan_type

        results = retriever.hybrid_search(
            query=query.strip(),
            keyword=None,
            top_k=top_k,
            filters=filters if filters else None,
        )
        return results
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description="应急预案向量检索")
    parser.add_argument("--query", required=True, help="查询内容")
    parser.add_argument("--plan-type", default=None,
                        choices=["防汛", "抗旱", "台风", "地质灾害", "综合"],
                        help="预案类型过滤")
    parser.add_argument("--top-k", type=int, default=5, help="返回结果数量（1-20）")
    args = parser.parse_args()

    top_k = max(1, min(args.top_k, 20))
    results = _try_vector_search(args.query, args.plan_type, top_k)

    if results is None:
        output = {
            "success": True,
            "data": {
                "query": args.query,
                "plan_type": args.plan_type,
                "results": [],
                "total": 0,
                "message": "预案知识库尚未建立或不可用，暂无法进行预案检索。",
            },
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    if not results:
        output = {
            "success": True,
            "data": {
                "query": args.query,
                "plan_type": args.plan_type,
                "results": [],
                "total": 0,
                "message": "未找到相关预案内容。",
            },
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    formatted = []
    for r in results:
        formatted.append({
            "text": r.get("text", ""),
            "similarity": round(r.get("similarity", 0), 4),
            "metadata": r.get("metadata", {}),
        })

    output = {
        "success": True,
        "data": {
            "query": args.query,
            "plan_type": args.plan_type,
            "results": formatted,
            "total": len(formatted),
        },
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

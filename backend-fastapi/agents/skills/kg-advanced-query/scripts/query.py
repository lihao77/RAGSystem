#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通用 Cypher 查询脚本

功能：执行任意 Cypher 查询并返回 JSON 结果
依赖：neo4j>=5.0.0
"""

import sys
import os
import json
import argparse

from neo4j import GraphDatabase
from neo4j.time import Date, DateTime, Time, Duration
from neo4j.spatial import Point


def neo4j_to_python(val):
    """递归将 Neo4j 所有类型转为 JSON 可序列化的 Python 原生类型。"""
    # Node / Relationship
    if hasattr(val, '_properties'):
        return {k: neo4j_to_python(v) for k, v in val._properties.items()}
    # 普通 dict（Path 中间结果等）
    if isinstance(val, dict):
        return {k: neo4j_to_python(v) for k, v in val.items()}
    # list / tuple
    if isinstance(val, (list, tuple)):
        return [neo4j_to_python(v) for v in val]
    # 时间类型 → ISO 字符串
    if isinstance(val, (DateTime, Date, Time)):
        return val.iso_format()
    # Duration → 组件 dict
    if isinstance(val, Duration):
        return {
            'months': val.months,
            'days': val.days,
            'seconds': val.seconds,
            'nanoseconds': val.nanoseconds,
        }
    # 空间类型 → dict
    if isinstance(val, Point):
        d = {'srid': val.srid, 'x': val.x, 'y': val.y}
        if hasattr(val, 'z'):
            d['z'] = val.z
        return d
    # 原生类型直接返回
    return val


def get_driver():
    uri = os.environ.get('NEO4J_URI', 'bolt://localhost:7687')
    user = os.environ.get('NEO4J_USER', 'neo4j')
    password = os.environ.get('NEO4J_PASSWORD', '')
    return GraphDatabase.driver(uri, auth=(user, password))


def run_query(cypher, params=None):
    driver = get_driver()
    try:
        with driver.session() as session:
            result = session.run(cypher, params or {})
            records = []
            for r in result:
                row = {key: neo4j_to_python(r[key]) for key in r.keys()}
                records.append(row)
        return records
    finally:
        driver.close()


def main():
    parser = argparse.ArgumentParser(description="执行 Cypher 查询")
    parser.add_argument("--cypher", required=True, help="Cypher 查询语句")
    parser.add_argument("--params", default="{}", help="查询参数（JSON 字符串）")
    parser.add_argument("--limit", type=int, default=100, help="最大返回行数（默认 100）")

    args = parser.parse_args()

    try:
        params = json.loads(args.params)

        # 自动附加 LIMIT（如果查询里没有）
        cypher = args.cypher.strip()
        if "LIMIT" not in cypher.upper():
            cypher = f"{cypher} LIMIT {args.limit}"

        records = run_query(cypher, params)

        print(json.dumps({
            "success": True,
            "data": {
                "records": records,
                "count": len(records)
            }
        }, ensure_ascii=False, indent=2))
        return 0

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())

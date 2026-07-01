#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
revise.py - 修改已有可视化 artifact 配置

输出 artifact 协议格式（action=revise），由 execute_skill_script 自动调用 manager.revise()。

用法:
  python revise.py --artifact-id viz_abc123 --config-patch '{"title":{"text":"新标题"}}'
  python revise.py --artifact-id viz_abc123 --config-patch '{"series":[...]}' --replace
"""

import sys
import json
import argparse


def main():
    parser = argparse.ArgumentParser(description="修改已有可视化 artifact")
    parser.add_argument("--artifact-id", required=True, help="要修改的 artifact ID")
    parser.add_argument("--config-patch", required=True, help="配置补丁 JSON")
    parser.add_argument("--replace", action="store_true",
                        help="是否完全替换（默认深度合并）")
    args = parser.parse_args()

    try:
        config_patch = json.loads(args.config_patch)
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"config-patch JSON 解析失败: {e}"}, ensure_ascii=False))
        sys.exit(1)

    if not isinstance(config_patch, dict):
        print(json.dumps({"success": False, "error": "config-patch 必须是 JSON 对象"}, ensure_ascii=False))
        sys.exit(1)

    output = {
        "success": True,
        "data": {
            "artifact_id": args.artifact_id,
            "message": "配置补丁已提交",
        },
        "artifact": {
            "action": "revise",
            "artifact_id": args.artifact_id,
            "config": config_patch,
            "replace": args.replace,
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()

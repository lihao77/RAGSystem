#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
revise.py - 修改已有可视化文件配置

输出通用文件引用；修改后的配置写回当前 cwd 指定的文件。

用法:
  python revise.py --file chart-bar.json --config-patch '{"title":{"text":"新标题"}}'
  python revise.py --file chart-bar.json --config-patch '{"series":[...]}' --replace
"""

import sys
import json
import argparse
import os


def main():
    parser = argparse.ArgumentParser(description="修改已有可视化文件")
    parser.add_argument("--file", required=True, help="cwd 下已有的图表 JSON 文件")
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

    file_path = os.path.abspath(args.file)
    with open(file_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    if args.replace:
        config = config_patch
    else:
        config = merge(config, config_patch)
    with open(file_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
    output = {
        "success": True,
        "data": {"message": "配置补丁已写回文件"},
        "file": {
            "path": os.path.relpath(file_path, os.getcwd()),
            "media_type": "application/json",
            "size": os.path.getsize(file_path),
            "metadata": {"kind": "chart.echarts"},
        },
    }
    print(json.dumps(output, ensure_ascii=False))


def merge(base, patch):
    if not isinstance(base, dict) or not isinstance(patch, dict):
        return patch
    merged = dict(base)
    for key, value in patch.items():
        merged[key] = merge(merged[key], value) if key in merged else value
    return merged


if __name__ == "__main__":
    main()

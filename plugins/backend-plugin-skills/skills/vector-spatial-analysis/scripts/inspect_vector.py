#!/usr/bin/env python3
"""Inspect vector metadata without returning feature geometry."""

from __future__ import annotations

import argparse
import math
import sys

from _shared import load_geopandas, print_json, summarize


def main() -> int:
    parser = argparse.ArgumentParser(description="检查矢量数据")
    parser.add_argument("--file", required=True)
    parser.add_argument("--layer")
    args = parser.parse_args()
    try:
        gpd, _ = load_geopandas()
        frame = gpd.read_file(args.file, **({"layer": args.layer} if args.layer else {}))
        numeric = frame.select_dtypes(include="number")
        numeric_summary = {}
        for column in numeric.columns:
            values = numeric[column].dropna()
            if not len(values):
                continue
            finite = [float(value) for value in values.head(100) if math.isfinite(float(value))]
            if len(finite) != min(len(values), 100):
                continue
            numeric_summary[str(column)] = {
                "count": int(values.count()),
                "min": float(values.min()),
                "max": float(values.max()),
                "mean": float(values.mean()),
            }
        data = summarize(frame)
        data.update({
            "file": args.file,
            "column_types": {str(column): str(dtype) for column, dtype in frame.dtypes.items() if column != frame.geometry.name},
            "numeric_summary": numeric_summary,
        })
        print_json({"success": True, "data": data})
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"inspect_vector: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"inspect_vector: 读取矢量数据失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

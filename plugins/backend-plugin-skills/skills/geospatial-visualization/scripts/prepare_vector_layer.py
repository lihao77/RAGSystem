#!/usr/bin/env python3
"""Prepare a vector dataset as a data-first GeoJSON Artifact V2."""

from __future__ import annotations

import argparse
import sys

from _shared import print_json, require_staging, safe_name


def main() -> int:
    parser = argparse.ArgumentParser(description="准备矢量地图图层数据")
    parser.add_argument("--file", required=True)
    parser.add_argument("--layer", default=None)
    parser.add_argument("--value-field", default=None)
    parser.add_argument("--title", default="")
    parser.add_argument("--output-name", default="vector-layer")
    args = parser.parse_args()
    try:
        import geopandas as gpd
        frame = gpd.read_file(args.file, **({"layer": args.layer} if args.layer else {}))
        if frame.crs is None:
            raise ValueError("矢量数据缺少 CRS，无法准备地图图层")
        if args.value_field and args.value_field not in frame.columns:
            raise ValueError(f"字段不存在: {args.value_field}")
        frame = frame.to_crs("EPSG:4326")
        values = []
        if args.value_field:
            for raw in frame[args.value_field]:
                try:
                    values.append(float(raw))
                except (TypeError, ValueError):
                    continue
            if not values:
                raise ValueError(f"字段 {args.value_field} 没有有效数值")
        value_range = {"min": min(values), "max": max(values)} if values else None
        output_dir = require_staging()
        filename = f"{safe_name(args.output_name, 'vector-layer')}.geojson"
        frame.to_file(output_dir / filename, driver="GeoJSON", index=False)
        title = args.title or f"{args.value_field or '矢量'}图层"
        if not len(frame):
            raise ValueError("矢量数据没有要素")
        bounds = [float(value) for value in frame.total_bounds]
        if bounds[0] == bounds[2]:
            bounds[0] -= 0.00001
            bounds[2] += 0.00001
        if bounds[1] == bounds[3]:
            bounds[1] -= 0.00001
            bounds[3] += 0.00001
        artifact = {
            "schema_version": 2,
            "kind": "geospatial.vector",
            "subtype": "thematic" if args.value_field else "geojson",
            "title": title,
            "assets": [{"asset_id": "data", "role": "data", "filename": filename, "media_type": "application/geo+json", "staged_file": filename}],
            "presentations": [],
            "metadata": {
                "spatial": {"crs": "EPSG:4326", "bounds": bounds},
                "feature_count": int(len(frame)),
                "geometry_types": sorted(str(value) for value in frame.geometry.geom_type.dropna().unique()),
                "value_field": args.value_field,
                "value_range": value_range,
            },
        }
        print_json({"success": True, "data": {"title": title, "feature_count": int(len(frame)), "crs": "EPSG:4326", "bounds": bounds, "value_field": args.value_field, "value_range": value_range}, "artifact": artifact})
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"prepare_vector_layer: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"prepare_vector_layer: 准备图层失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from _shared import crs_text, print_json, raster_artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Rasterize vector features")
    parser.add_argument("--input", required=True)
    parser.add_argument("--resolution", type=float, required=True, help="像元大小，单位为输入 CRS 单位")
    parser.add_argument("--attribute", help="栅格化字段；不提供时使用 --value")
    parser.add_argument("--value", type=float, default=1)
    parser.add_argument("--all-touched", action="store_true")
    parser.add_argument("--output-name", default="rasterized")
    args = parser.parse_args()
    try:
        if args.resolution <= 0:
            raise ValueError("--resolution 必须大于 0")
        import geopandas as gpd
        import numpy as np
        import rasterio
        from rasterio.features import rasterize
        from rasterio.transform import from_origin

        frame = gpd.read_file(args.input)
        if frame.empty:
            raise ValueError("输入矢量为空")
        if frame.crs is None:
            raise ValueError("输入矢量缺少 CRS")
        west, south, east, north = [float(value) for value in frame.total_bounds]
        width = max(1, int((east - west) / args.resolution + 0.999999))
        height = max(1, int((north - south) / args.resolution + 0.999999))
        transform = from_origin(west, north, args.resolution, args.resolution)
        if args.attribute and args.attribute not in frame.columns:
            raise ValueError(f"字段不存在: {args.attribute}")
        if args.attribute:
            try:
                attribute_values = frame[args.attribute].astype("float64").tolist()
            except (TypeError, ValueError) as error:
                raise ValueError("--attribute 字段必须是数值字段") from error
        else:
            attribute_values = [args.value] * len(frame)
        pairs = ((geometry, float(value)) for geometry, value in zip(frame.geometry, attribute_values))
        array = rasterize(pairs, out_shape=(height, width), transform=transform, fill=0, all_touched=args.all_touched, dtype="float32")
        profile = {"driver": "GTiff", "crs": crs_text(frame.crs), "transform": transform, "nodata": 0, "dtype": "float32", "count": 1}
        artifact = raster_artifact(array, profile, args.output_name, "rasterize", f"Rasterize · {Path(args.input).name}", {"input": args.input, "attribute": args.attribute, "resolution": args.resolution})
        print_json({"success": True, "artifact": artifact, "shape": [height, width]})
        return 0
    except (OSError, ValueError, RuntimeError, ImportError, TypeError) as error:
        print(f"spatial-conversion: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

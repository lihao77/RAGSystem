from __future__ import annotations

import argparse
import sys
from pathlib import Path

from _shared import print_json, vector_file


def main() -> int:
    parser = argparse.ArgumentParser(description="Polygonize a raster band")
    parser.add_argument("--input", required=True)
    parser.add_argument("--band", type=int, default=1)
    parser.add_argument("--mask", action="store_true", help="仅输出有效像元")
    parser.add_argument("--output-name", default="polygonized")
    args = parser.parse_args()
    try:
        import geopandas as gpd
        import rasterio
        from rasterio.features import shapes
        from shapely.geometry import shape

        with rasterio.open(args.input) as source:
            if args.band < 1 or args.band > source.count:
                raise ValueError(f"--band 必须在 1 到 {source.count} 之间")
            values = source.read(args.band)
            mask = source.read_masks(args.band) > 0 if args.mask else None
            records = [{"value": value, "geometry": shape(geometry)} for geometry, value in shapes(values, mask=mask, transform=source.transform)]
            frame = gpd.GeoDataFrame(records, geometry="geometry", crs=source.crs)
            file = vector_file(frame, args.output_name, "polygonize", f"Polygonize · {Path(args.input).name}", {"input": args.input, "band": args.band})
            print_json({"success": True, "file": file, "feature_count": len(frame)})
            return 0
    except (OSError, ValueError, RuntimeError, ImportError, TypeError) as error:
        print(f"spatial-conversion: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())


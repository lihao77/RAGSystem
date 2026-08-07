from __future__ import annotations

import argparse
import sys
from pathlib import Path

from _shared import print_json, output_dir, safe_name, crs_text


def main() -> int:
    parser = argparse.ArgumentParser(description="Write a cloud-optimized GeoTIFF")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-name", default="raster-cog")
    parser.add_argument("--overview-levels", default="2,4,8,16")
    args = parser.parse_args()
    try:
        import rasterio
        from rasterio.enums import Resampling

        filename = f"{safe_name(args.output_name, 'raster-cog')}.tif"
        levels = [int(level) for level in args.overview_levels.split(",") if level.strip()]
        if any(level < 2 or level & (level - 1) for level in levels):
            raise ValueError("overview levels 必须是大于等于 2 的 2 的幂")
        with rasterio.open(args.input) as source:
            levels = [level for level in levels if source.width // level >= 2 and source.height // level >= 2]
            profile = source.profile.copy()
            profile.update(driver="GTiff", tiled=True, compress="deflate", blockxsize=256, blockysize=256)
            with rasterio.open(output_dir() / filename, "w", **profile) as target:
                target.write(source.read())
                if levels:
                    target.build_overviews(levels, Resampling.average)
                    target.update_tags(ns="rio_overview", resampling="average")
            target_path = output_dir() / filename
            file = {"path": filename, "media_type": "image/tiff; application=geotiff; profile=cloud-optimized", "size": target_path.stat().st_size,
                    "metadata": {"spatial": {"crs": crs_text(source.crs), "bounds": [float(source.bounds.left), float(source.bounds.bottom), float(source.bounds.right), float(source.bounds.top)]}, "processing": {"overview_levels": levels}}}
            print_json({"success": True, "file": file})
            return 0
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print(f"spatial-conversion: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())


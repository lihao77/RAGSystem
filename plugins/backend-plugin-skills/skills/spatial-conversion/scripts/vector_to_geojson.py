from __future__ import annotations

import argparse
import sys
from pathlib import Path

from _shared import print_json, vector_artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a vector dataset to GeoJSON")
    parser.add_argument("--input", required=True)
    parser.add_argument("--layer")
    parser.add_argument("--output-name", default="vector")
    args = parser.parse_args()
    try:
        import geopandas as gpd

        frame = gpd.read_file(args.input, layer=args.layer) if args.layer else gpd.read_file(args.input)
        artifact = vector_artifact(frame, args.output_name, "vector_to_geojson", f"GeoJSON · {Path(args.input).name}", {"input": args.input, "layer": args.layer})
        print_json({"success": True, "artifact": artifact, "feature_count": len(frame)})
        return 0
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print(f"spatial-conversion: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

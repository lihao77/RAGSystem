#!/usr/bin/env python3
"""Prepare a raster band as a WGS84 PNG layer File V2."""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from _shared import print_json, output_dir, safe_name


def _palette(name: str, values):
    import numpy as np
    clipped = np.clip(values, 0.0, 1.0)
    if name == "gray":
        rgb = np.repeat(clipped[..., None], 3, axis=2)
    elif name == "terrain":
        stops = np.array([[0.08, 0.20, 0.45], [0.10, 0.55, 0.35], [0.75, 0.70, 0.30], [0.95, 0.95, 0.90]])
        rgb = _interpolate(stops, clipped)
    elif name == "bluered":
        stops = np.array([[0.10, 0.25, 0.80], [0.90, 0.90, 0.90], [0.80, 0.10, 0.08]])
        rgb = _interpolate(stops, clipped)
    else:
        stops = np.array([[0.27, 0.00, 0.33], [0.13, 0.57, 0.55], [0.99, 0.91, 0.14]])
        rgb = _interpolate(stops, clipped)
    return (rgb * 255).astype("uint8")


def _interpolate(stops, values):
    import numpy as np
    positions = np.linspace(0, 1, len(stops))
    channels = [np.interp(values, positions, stops[:, index]) for index in range(3)]
    return np.stack(channels, axis=-1)


def main() -> int:
    parser = argparse.ArgumentParser(description="准备栅格地图图层数据")
    parser.add_argument("--file", required=True)
    parser.add_argument("--band", type=int, default=1)
    parser.add_argument("--max-size", type=int, default=1200)
    parser.add_argument("--palette", choices=["viridis", "terrain", "gray", "bluered"], default="viridis")
    parser.add_argument("--title", default="")
    parser.add_argument("--output-name", default="raster-layer")
    args = parser.parse_args()
    try:
        import numpy as np
        import rasterio
        from PIL import Image
        from rasterio.enums import Resampling
        from rasterio.vrt import WarpedVRT
        if args.max_size < 16:
            raise ValueError("max-size 太小")
        with rasterio.open(args.file) as src:
            if args.band < 1 or args.band > src.count:
                raise ValueError(f"band 必须在 1 到 {src.count} 之间")
            if src.crs is None:
                raise ValueError("栅格数据缺少 CRS，无法准备地图图层")
            source_crs = src.crs.to_string()
            source_bounds = [float(value) for value in src.bounds]
            with WarpedVRT(src, crs="EPSG:4326", resampling=Resampling.bilinear) as vrt:
                factor = max(vrt.width / args.max_size, vrt.height / args.max_size, 1)
                height, width = max(1, int(vrt.height / factor)), max(1, int(vrt.width / factor))
                sample = vrt.read(args.band, out_shape=(height, width), masked=True).astype("float32")
                bounds = [float(value) for value in vrt.bounds]
                valid = sample.compressed()
                if not valid.size:
                    raise ValueError("指定波段没有有效像元")
                minimum, maximum = float(valid.min()), float(valid.max())
                normalized = np.zeros(sample.shape, dtype="float32")
                if maximum > minimum:
                    normalized = (sample.filled(minimum) - minimum) / (maximum - minimum)
                rgb = _palette(args.palette, normalized)
                mask = np.ma.getmaskarray(sample)
                alpha = np.where(mask, 0, 255).astype("uint8")
                rgba = np.concatenate([rgb, alpha[..., None]], axis=2)
                image_buffer = io.BytesIO()
                Image.fromarray(rgba, mode="RGBA").save(image_buffer, format="PNG", optimize=True)
                output_root = output_dir()
                filename = f"{safe_name(args.output_name, 'raster-layer')}.png"
                (output_root / filename).write_bytes(image_buffer.getvalue())
                title = args.title or f"{Path(args.file).name} · Band {args.band}"
                file = {"path": filename, "media_type": "image/png", "size": (output_root / filename).stat().st_size,
                        "metadata": {
                        "spatial": {"crs": "EPSG:4326", "bounds": bounds},
                        "source": args.file,
                        "source_crs": source_crs,
                        "source_bounds": source_bounds,
                        "band": args.band,
                        "value_range": {"min": minimum, "max": maximum},
                        "palette": args.palette,
                        "width": width,
                        "height": height,
                    }}
        print_json({"success": True, "data": {"title": title, "statistics": {"min": minimum, "max": maximum, "valid_count": int(valid.size)}, "preview_shape": [height, width]}, "file": file})
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"prepare_raster_layer: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"prepare_raster_layer: 准备图层失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())


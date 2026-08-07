from __future__ import annotations

import argparse
import heapq
import math
import sys
from pathlib import Path

import numpy as np

from _shared import print_json, write_raster, write_vector


NEIGHBOURS = [(-1, -1, 128), (-1, 0, 64), (-1, 1, 32), (0, -1, 16), (0, 1, 1), (1, -1, 8), (1, 0, 4), (1, 1, 2)]


def read_dem(path: str, band: int) -> tuple[object, np.ndarray]:
    import rasterio

    source = rasterio.open(path)
    if source.crs is None:
        source.close()
        raise ValueError("DEM 缺少 CRS")
    if band < 1 or band > source.count:
        source.close()
        raise ValueError(f"--band 必须在 1 到 {source.count} 之间")
    values = source.read(band).astype("float64")
    if source.nodata is not None:
        values[values == source.nodata] = np.nan
    return source, values


def _gradient(values: np.ndarray, source: object) -> tuple[np.ndarray, np.ndarray]:
    dx = abs(float(source.transform.a))
    dy = abs(float(source.transform.e))
    gy, gx = np.gradient(values, dy, dx)
    return gx, gy


def _fill_sinks(values: np.ndarray) -> np.ndarray:
    filled = values.copy()
    valid = np.isfinite(filled)
    if not valid.any():
        return filled
    rows, cols = filled.shape
    visited = np.zeros_like(valid, dtype=bool)
    queue: list[tuple[float, int, int]] = []
    for row in range(rows):
        for col in range(cols):
            if valid[row, col] and (row in (0, rows - 1) or col in (0, cols - 1)):
                visited[row, col] = True
                heapq.heappush(queue, (float(filled[row, col]), row, col))
    while queue:
        elevation, row, col = heapq.heappop(queue)
        for dr, dc, _ in NEIGHBOURS:
            nr, nc = row + dr, col + dc
            if not (0 <= nr < rows and 0 <= nc < cols) or not valid[nr, nc] or visited[nr, nc]:
                continue
            visited[nr, nc] = True
            filled[nr, nc] = max(float(filled[nr, nc]), elevation)
            heapq.heappush(queue, (float(filled[nr, nc]), nr, nc))
    return filled


def _flow_direction(values: np.ndarray, source: object) -> np.ndarray:
    result = np.zeros(values.shape, dtype="uint8")
    cell_x, cell_y = abs(float(source.transform.a)), abs(float(source.transform.e))
    for row in range(values.shape[0]):
        for col in range(values.shape[1]):
            if not np.isfinite(values[row, col]):
                continue
            best_drop, best_code = 0.0, 0
            current = float(values[row, col])
            for dr, dc, code in NEIGHBOURS:
                nr, nc = row + dr, col + dc
                if not (0 <= nr < values.shape[0] and 0 <= nc < values.shape[1]) or not np.isfinite(values[nr, nc]):
                    continue
                distance = math.hypot(dc * cell_x, dr * cell_y)
                drop = (current - float(values[nr, nc])) / distance
                if drop > best_drop:
                    best_drop, best_code = drop, code
            result[row, col] = best_code
    return result


def _flow_accumulation(direction: np.ndarray) -> np.ndarray:
    rows, cols = direction.shape
    code_to_delta = {code: (dr, dc) for dr, dc, code in NEIGHBOURS}
    incoming = np.zeros_like(direction, dtype="int32")
    for row in range(rows):
        for col in range(cols):
            delta = code_to_delta.get(int(direction[row, col]))
            if delta:
                nr, nc = row + delta[0], col + delta[1]
                if 0 <= nr < rows and 0 <= nc < cols:
                    incoming[nr, nc] += 1
    result = np.ones(direction.shape, dtype="float32")
    queue = [(row, col) for row in range(rows) for col in range(cols) if incoming[row, col] == 0]
    index = 0
    while index < len(queue):
        row, col = queue[index]
        index += 1
        delta = code_to_delta.get(int(direction[row, col]))
        if not delta:
            continue
        nr, nc = row + delta[0], col + delta[1]
        if 0 <= nr < rows and 0 <= nc < cols:
            result[nr, nc] += result[row, col]
            incoming[nr, nc] -= 1
            if incoming[nr, nc] == 0:
                queue.append((nr, nc))
    return result


def _contours(values: np.ndarray, source: object, interval: float, base: float) -> object:
    import geopandas as gpd
    from shapely.geometry import LineString

    lines: list[dict[str, object]] = []
    valid = values[np.isfinite(values)]
    if valid.size == 0 or interval <= 0:
        return gpd.GeoDataFrame([], geometry="geometry", crs=source.crs)
    levels = np.arange(math.floor((float(valid.min()) - base) / interval) * interval + base, float(valid.max()) + interval, interval)
    transform = source.transform
    for level in levels:
        segments: list[LineString] = []
        for row in range(values.shape[0] - 1):
            for col in range(values.shape[1] - 1):
                cell = values[row : row + 2, col : col + 2]
                if not np.isfinite(cell).all() or float(cell.min()) > level or float(cell.max()) < level:
                    continue
                points: list[tuple[float, float]] = []
                corners = [((0, 0), (0, 1)), ((0, 1), (1, 1)), ((1, 1), (1, 0)), ((1, 0), (0, 0))]
                for (r1, c1), (r2, c2) in corners:
                    v1, v2 = float(cell[r1, c1]), float(cell[r2, c2])
                    if (v1 < level) != (v2 < level) and v1 != v2:
                        fraction = (level - v1) / (v2 - v1)
                        x = col + c1 + fraction * (c2 - c1)
                        y = row + r1 + fraction * (r2 - r1)
                        points.append((x, y))
                if len(points) >= 2:
                    segments.append(LineString([transform * points[0], transform * points[1]]))
        lines.extend({"elevation": float(level), "geometry": line} for line in segments)
    return gpd.GeoDataFrame(lines, geometry="geometry", crs=source.crs)


def process(operation: str, args: argparse.Namespace) -> dict[str, object]:
    source, values = read_dem(args.input, args.band)
    try:
        if operation == "slope":
            gx, gy = _gradient(values, source)
            output = np.degrees(np.arctan(np.hypot(gx, gy))).astype("float32")
        elif operation == "aspect":
            gx, gy = _gradient(values, source)
            output = ((np.degrees(np.arctan2(-gx, gy)) + 360.0) % 360.0).astype("float32")
        elif operation == "hillshade":
            gx, gy = _gradient(values, source)
            slope = np.arctan(np.hypot(gx, gy))
            aspect = np.arctan2(-gx, gy)
            azimuth, altitude = math.radians(args.azimuth), math.radians(args.altitude)
            output = (255.0 * (np.cos(altitude) * np.cos(slope) + np.sin(altitude) * np.sin(slope) * np.cos(azimuth - aspect))).clip(0, 255).astype("float32")
        elif operation == "fill_sinks":
            output = _fill_sinks(values).astype("float32")
        elif operation == "flow_direction":
            output = _flow_direction(values).astype("uint8")
        elif operation == "flow_accumulation":
            output = _flow_accumulation(_flow_direction(values))
        elif operation == "watershed":
            if args.pour_row is None or args.pour_col is None:
                raise ValueError("watershed 需要 --pour-row 和 --pour-col")
            direction = _flow_direction(values)
            code_to_delta = {code: (dr, dc) for dr, dc, code in NEIGHBOURS}
            selected = np.zeros(direction.shape, dtype="uint8")
            stack = [(args.pour_row, args.pour_col)]
            while stack:
                row, col = stack.pop()
                if not (0 <= row < direction.shape[0] and 0 <= col < direction.shape[1]) or selected[row, col]:
                    continue
                selected[row, col] = 1
                for dr, dc, code in NEIGHBOURS:
                    nr, nc = row + dr, col + dc
                    if 0 <= nr < direction.shape[0] and 0 <= nc < direction.shape[1] and code_to_delta.get(int(direction[nr, nc])) == (row - nr, col - nc):
                        stack.append((nr, nc))
            output = selected
        elif operation == "contour":
            frame = _contours(values, source, args.interval, args.base)
            file = write_vector(frame, args.output_name, operation, f"Contours · {Path(args.input).name}", {"interval": args.interval, "base": args.base})
            return {"success": True, "file": file, "feature_count": len(frame)}
        else:
            raise ValueError(f"未知地形水文工具: {operation}")
        invalid = ~np.isfinite(values)
        output[invalid] = 0 if getattr(output.dtype, "kind", "f") in "ui" else -9999.0
        file = write_raster(output, source, args.output_name, operation, f"{operation} · {Path(args.input).name}", {"input": args.input})
        return {"success": True, "file": file, "shape": list(output.shape)}
    finally:
        source.close()


def main(forced_operation: str) -> int:
    parser = argparse.ArgumentParser(description=f"Terrain and hydrology analysis: {forced_operation}")
    parser.add_argument("--input", required=True)
    parser.add_argument("--band", type=int, default=1)
    parser.add_argument("--output-name", default=forced_operation)
    if forced_operation == "hillshade":
        parser.add_argument("--azimuth", type=float, default=315.0)
        parser.add_argument("--altitude", type=float, default=45.0)
    if forced_operation == "contour":
        parser.add_argument("--interval", type=float, required=True)
        parser.add_argument("--base", type=float, default=0.0)
    if forced_operation == "watershed":
        parser.add_argument("--pour-row", type=int, required=True)
        parser.add_argument("--pour-col", type=int, required=True)
    args = parser.parse_args()
    try:
        print_json(process(forced_operation, args))
        return 0
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print(f"terrain-hydrology-analysis: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main("slope"))


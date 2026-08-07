---
name: spatial-data-management
description: Inspect, validate, copy, repair, reproject and manage fields in vector and raster spatial datasets, and calculate grouped attribute statistics. Use for GeoJSON, GeoPackage, Shapefile, GeoTIFF, COG and other GeoPandas/Rasterio-readable files when an agent needs dataset metadata, CRS checks, schema changes or table summaries.
---

# Spatial Data Management

Use one independent script for one operation. Activate this skill, then call `execute_skill_script` with the exact `script_name` and an argv-token array. Do not combine operations behind an operation flag when a same-name entry exists.

## Execution

```json
{
  "skill_name": "spatial-data-management",
  "script_name": "describe_vector.py",
  "arguments": ["--input", "D:\\data\\roads.gpkg", "--layer", "roads"]
}
```

Inspection scripts (`describe_vector.py`, `describe_raster.py`, `list_layers.py`, `validate_crs.py`) return JSON only. Data-producing scripts write to the Agent-selected cwd and return a generic file reference. Never invent a path. Use `map_add_file_layer` only when the user requests an interactive map and the current tool schema explicitly provides it; final file references must point to workspace files.

## Operations

- `describe_vector.py`: feature count, geometry types, fields, numeric fields, bounds and CRS. Required: `--input`; optional `--layer`.
- `describe_raster.py`: driver, dimensions, bands, dtypes, NoData, bounds, resolution and CRS. Required: `--input`.
- `list_layers.py`: list layers in a GeoPackage or other GDAL container. Required: `--input`.
- `validate_crs.py`: check whether a vector or raster declares a CRS, optionally compare to `--expected-crs`. Required: `--input`; optional `--data-type auto|vector|raster`, `--expected-crs`.
- `define_projection.py`: assign a CRS without transforming coordinates. Required: `--input`, `--target-crs`; add `--allow-override` to replace an existing declaration.
- `repair_geometry.py`: repair invalid vector geometries using Shapely validity operations. Required: `--input`.
- `copy_features.py`: copy a vector dataset to a new staged GeoJSON File. Required: `--input`.
- `delete_fields.py`: remove non-geometry fields. Required: `--input`, `--fields field_a,field_b`.
- `rename_fields.py`: rename non-geometry fields. Required: `--input`, `--mapping old:new,old2:new2`.
- `calculate_field.py`: add or replace a field using a safe expression. Required: `--input`, `--field`, `--expression`; reference values as `!field_name!`. Supported functions are `abs`, `round`, `min`, `max`, `sqrt` and `log`.
- `summary_statistics.py`: produce a table File from `count`, `sum`, `mean`, `min`, `max`, `median` or `std` statistics. Required: `--input`, `--stats POP:sum,POP:mean`; optional `--by CLASS`.

All producing scripts accept `--output-name NAME`. GeoPackage inputs can select a layer with `--layer`. Input files are read-only; output files are written under the Agent-selected cwd and returned as a `file` object with `path`, `media_type`, `size`, and metadata.

Read [data-management.md](references/data-management.md) for parameter details, CRS rules, and file shape.


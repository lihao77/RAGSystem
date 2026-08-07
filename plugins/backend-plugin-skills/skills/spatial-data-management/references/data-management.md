# Data Management Reference

## Common arguments

| Argument | Meaning |
| --- | --- |
| `--input PATH` | Input vector/raster path. Repeat is not supported in this skill. |
| `--layer NAME` | Optional GeoPackage/GDAL vector layer. |
| `--output-name NAME` | Safe basename for the staged output. |

## CRS

`validate_crs.py` uses `--data-type auto|vector|raster`; auto first attempts a vector read and then Rasterio. `--expected-crs` accepts values understood by pyproj, such as `EPSG:4326` or `EPSG:3857`. A missing CRS makes `valid` false. `define_projection.py` only changes the CRS declaration; it does not move coordinates. Use a reprojection tool from the vector-analysis skill when coordinates must be transformed.

## Field operations

`delete_fields.py --fields` takes a comma-separated list and never permits deleting the geometry column. `rename_fields.py --mapping` uses comma-separated `old:new` pairs and rejects duplicate or already occupied targets. `calculate_field.py` evaluates a restricted expression language; arbitrary Python, imports, attribute access, indexing and unlisted calls are rejected. Field values are inserted through `!FIELD!` tokens.

## Statistics

`summary_statistics.py --stats` accepts comma-separated `FIELD:METHOD` specifications. Methods are `count`, `sum`, `mean`, `min`, `max`, `median` and `std` (`stddev` is accepted as an alias). `--by` accepts comma-separated grouping fields. The result is a JSON table Artifact with `kind: table.dataset`; it is not a map layer.

## Artifact contract

Vector outputs are GeoJSON in `RAGSYSTEM_ARTIFACT_OUTPUT_DIR` with media type `application/geo+json`, `kind: geospatial.vector`, and WGS84 bounds in `metadata.spatial`. Statistics use a JSON asset with media type `application/json` and `kind: table.dataset`. Scripts do not create artifact IDs or map configuration.

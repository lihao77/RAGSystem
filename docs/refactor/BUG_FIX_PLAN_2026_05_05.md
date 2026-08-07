# Rendering Contract Notes

The frontend rendering boundary is intentionally small:

- Chart artifacts are rendered from a `chart.echarts` presentation.
- Spatial artifacts are rendered from Artifact V2 Assets through the MapLibre workspace.
- Spatial metadata is nested under `metadata.spatial` and uses WGS84 bounds.
- Map state changes are explicit `map_*` host tool calls.

When changing spatial behavior, update the Skill contract, the Artifact registry tests, and the host-tool tests together. Do not restore renderer-specific map payloads or implicit map-opening behavior.

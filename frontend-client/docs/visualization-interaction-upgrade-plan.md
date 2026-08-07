# Visualization Interaction Policy

This document describes the current interaction contract for visual artifacts. It is an implementation policy, not a compatibility plan.

## Chart Artifacts

Chart Skills create an Artifact V2 manifest with a `chart.echarts` presentation. `VisualizationLoader.vue` loads that presentation and passes its ECharts option to `ChartRenderer.vue`.

## Spatial Artifacts

Spatial Skills create data Assets and an empty `presentations` array. Every map-ready artifact must include:

```json
{
  "metadata": {
    "spatial": {
      "crs": "EPSG:4326",
      "bounds": [west, south, east, north]
    }
  }
}
```

The Skill tells the model to call `map_add_artifact_layer` with the artifact ID. The browser then resolves the Asset and adds a MapLibre source and layer. Spatial processing and map rendering are deliberately separate: Skills calculate and persist data, while the browser owns interaction and viewport state.

## Layer Operations

The model can add, remove, list, hide, reorder, fit, clear, and restyle supported layers through the `map_*` host tools. GeoJSON styles support categorical matches and numeric step/interpolate palettes keyed by a feature property. The map workspace exposes the same operations to its local controls and shows the thematic legend. Observations are compact state records and never include inline GeoJSON.

## Supported Sources

- `application/geo+json` data Assets become GeoJSON vector layers.
- `image/png`, `image/jpeg`, `image/webp`, and `image/gif` Assets become georeferenced image layers.
- Raster tile templates in `metadata.spatial.tiles` become raster tile layers.

All sources are WGS84 at the rendering boundary. Skills must reproject before creating the Artifact.

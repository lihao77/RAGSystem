# Frontend Architecture

## Runtime

The frontend is a Vue 3 + Vite application. Chat execution is driven by the session WebSocket and Pinia stores. ECharts renders chart presentations. MapLibre GL renders spatial data in the map workspace.

## Session Browser Workspaces

The project view is built from the active workspace list, while the timeline is built from session history. Removing a project with sessions soft-removes its workspace registration: the project and its sessions disappear from the project view, but the sessions and their workspace metadata remain available in the timeline. Adding the same canonical local path reactivates the existing workspace ID, which restores those sessions in the project view without rewriting session records. A workspace with no sessions is deleted outright so unused registrations do not accumulate.

## Artifact Contract

All persisted artifacts use Artifact V2 manifests:

```json
{
  "schema_version": 2,
  "artifact_id": "art_example",
  "kind": "vector.geojson",
  "assets": [
    {
      "asset_id": "data",
      "role": "data",
      "filename": "result.geojson",
      "media_type": "application/geo+json"
    }
  ],
  "presentations": [],
  "metadata": {
    "spatial": {
      "crs": "EPSG:4326",
      "bounds": [100, 20, 110, 30]
    }
  }
}
```

Spatial artifacts do not contain map renderer configuration. Their assets and `metadata.spatial` are the complete map input. Chart artifacts may use a chart presentation.

## Map Workspace

`src/components/map-workspace/MapWorkspace.vue` owns the MapLibre instance and the visible layer list. `ArtifactMapScreen.vue` provides the full-screen workspace shell. `layerDescriptors.js` is the only conversion boundary between application layer descriptors and MapLibre sources/layers.

The workspace supports:

- GeoJSON vector layers with default or explicit thematic styles.
- Georeferenced PNG, JPEG, WebP, or GIF image layers using WGS84 bounds.
- Raster tile templates with WGS84 bounds and zoom metadata.
- Visibility, opacity, ordering, removal, fit-to-layer, and viewport controls.
- Categorical, stepped, and continuous thematic color expressions for GeoJSON properties, with an inline legend.

`useArtifactMapWorkspace.js` resolves an Artifact manifest and binds the workspace controller to the host tool runtime. The registry accepts WGS84 spatial metadata only. Coordinate transformation belongs in the spatial Skill before persistence.

## Host Tools

The browser declares and executes these tools:

`map_add_artifact_layer`, `map_set_layer_style`, `map_remove_layer`, `map_list_layers`, `map_set_layer_visibility`, `map_set_layer_opacity`, `map_reorder_layer`, `map_fit_layer`, `map_clear_layers`, `map_get_viewport`, and `map_set_viewport`.

The model passes an Artifact ID to add a layer. The browser fetches the Manifest and Asset, validates the spatial contract, and adds a MapLibre layer. Tool observations contain identifiers and state only; they never contain the full spatial payload.

## Rendering Boundaries

- `VisualizationLoader.vue` handles chart, image, and generic file artifacts.
- The map workspace handles spatial artifacts only after `map_add_artifact_layer`.
- Chat messages and Artifact selection do not auto-open a map or infer a map presentation.
- No renderer configuration, legacy map payload, or alternate map engine is supported.

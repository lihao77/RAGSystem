# Mainline Extension Points

## Spatial Skills

Spatial processing belongs in the backend Skill packages:

- `vector-spatial-analysis` for vector inspection and operations.
- `raster-spatial-analysis` for raster inspection and operations.
- `geospatial-visualization` for preparing vector, raster, and chart artifacts.

Every map-ready Skill emits an Artifact V2 data Asset, an empty `presentations` array, and `metadata.spatial` with WGS84 `crs` and `[west, south, east, north]` bounds.

## Browser Map Surface

The frontend map boundary is `frontend-client/src/components/map-workspace/`. `MapWorkspace.vue` owns MapLibre sources and layers. `artifactLayerRegistry.js` validates manifests and resolves Assets. `useArtifactMapWorkspace.js` binds the runtime controller exposed through `hostTools.js`.

The model interacts with the map through `map_*` host tools. It never emits a map renderer configuration and the chat message stream never infers a map from presentation metadata.

## Adding A New Spatial Source

1. Add a Skill-side preparation script that emits a supported Asset and WGS84 spatial metadata.
2. Add a descriptor type in `layerDescriptors.js` only when MapLibre needs a new source kind.
3. Add registry and workspace contract tests.
4. Add the tool-facing operation only when it changes browser state.

Do not add alternate map engines, legacy payload parsing, or automatic map triggers.

# Visualization Interaction Policy

This document describes the current interaction contract for visual artifacts. It is an implementation policy, not a compatibility plan.

## Chart Artifacts

Chart Skills create an Artifact V2 manifest with a `chart.echarts` presentation. `VisualizationLoader.vue` loads that presentation and passes its ECharts option to `ChartRenderer.vue`.

## Image and File Artifacts

`VisualizationLoader.vue` also renders image Assets inline and falls back to a generic file view for other asset types. Renderers never receive inline payloads in chat messages; they always resolve the Artifact manifest and its Assets.

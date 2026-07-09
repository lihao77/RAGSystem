/**
 * 地图工具集出口：MapAdapter 契约 + createMapTools 工厂。
 */
export { createMapTools } from "./create-map-tools.js";
export type {
  MapAdapter,
  MapViewport,
  MapFeature,
  MapOverlay,
  MapOverlayType,
  MapOverlayRef,
  BBox,
  LngLat,
} from "./map-adapter.js";

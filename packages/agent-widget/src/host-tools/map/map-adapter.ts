/**
 * 地图工具集适配器契约。
 *
 * widget 包不绑定任何具体地图库（高德/百度/Leaflet/Cesium/Mapbox…）——宿主实现此接口，
 * createMapTools(adapter) 据已实现方法生成对应工具。能力声明式：未实现的方法不生成工具，
 * 不同地图能力不对等时优雅降级。
 *
 * adapter 方法内部调宿主地图组件 API（从组件拿数据 / 操作组件），是 hostTool "execute 不自查、
 * 从组件拿"原则的标准化通道——查询类 observation 同源（返回值即地图组件那份数据，答=画）。
 */

/** 经纬度坐标 [经度, 纬度]。 */
export type LngLat = [number, number];

/** 边界框 [minLng, minLat, maxLng, maxLat]。 */
export type BBox = [number, number, number, number];

/** 地图当前视口。 */
export interface MapViewport {
  center: LngLat;
  zoom: number;
  extent?: BBox;
}

/** 地图要素（GeoJSON Feature 的精简形态）。 */
export interface MapFeature {
  id?: string | number;
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}

/** 覆盖物类型。 */
export type MapOverlayType = "marker" | "line" | "polygon" | "circle" | "other";

/** 覆盖物（marker/线/面/圆，由 addOverlay 返回 id 供后续移除）。 */
export interface MapOverlay {
  type: MapOverlayType;
  /** marker: [lng,lat]；line: [lng,lat,...]；polygon: [[lng,lat],...]；circle: { center: LngLat; radius: number } */
  coordinates: unknown;
  /** 样式/属性（color/title 等，按地图库约定）。 */
  properties?: Record<string, unknown>;
}

/** addOverlay 返回的覆盖物引用。 */
export interface MapOverlayRef {
  id: string;
}

/**
 * 地图适配器：所有方法可选，宿主按地图能力实现。createMapTools 只为已实现方法生成工具。
 *
 * - 查询类（只读，observation 同源）：getViewport / queryByExtent / getVisibleFeatures
 * - 操作类（副作用，驱动视图，经 runUiTool 串行治理）：setViewport / flyTo / panTo / zoomTo /
 *   addOverlay / removeOverlay / highlight / clearOverlays
 */
export interface MapAdapter {
  // —— 查询类（只读）——
  getViewport?(): Promise<MapViewport>;
  queryByExtent?(extent: BBox): Promise<MapFeature[]>;
  getVisibleFeatures?(): Promise<MapFeature[]>;

  // —— 操作类（副作用）——
  setViewport?(viewport: Partial<MapViewport>): Promise<void>;
  flyTo?(target: { center?: LngLat; zoom?: number }): Promise<void>;
  panTo?(center: LngLat): Promise<void>;
  zoomTo?(zoom: number): Promise<void>;
  addOverlay?(overlay: MapOverlay): Promise<MapOverlayRef>;
  removeOverlay?(id: string): Promise<void>;
  clearOverlays?(): Promise<void>;
  highlight?(featureIds: string[]): Promise<void>;
}

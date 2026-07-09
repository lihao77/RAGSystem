/**
 * 地图工具集工厂：据 MapAdapter 已实现方法生成 HostToolDeclaration[]。
 *
 * 宿主实现 adapter → createMapTools(adapter) 拿工具数组 → 循环 registerHostTool 注册给 widget。
 * 未实现的 adapter 方法不生成对应工具（能力声明式降级）。
 *
 * 视图抢占治理：操作类工具（setViewport/flyTo/panTo/zoomTo/addOverlay/removeOverlay/highlight/
 * clearOverlays）经 runUiTool 串行队列 + 间隔执行，避免一个回合内 panTo/flyTo/zoom 连发导致
 * 地图视图打架。查询类工具（getViewport/queryByExtent/getVisibleFeatures）只读，不进队列。
 *
 * observation 同源：查询类工具的摘要来自 adapter 返回值（地图组件那份数据），不双调、答=画。
 */
import type { ToolResult } from "@ragsystem/agent-protocol";
import type { HostToolDeclaration } from "../types.js";
import type {
  BBox,
  LngLat,
  MapAdapter,
  MapFeature,
  MapOverlay,
  MapViewport,
} from "./map-adapter.js";

/** UI 工具间最小间隔（ms），给用户看清视图变化。 */
const UI_GAP = 1200;

function ok(observation: string): ToolResult {
  return { ok: true, observation };
}
function fail(error: string): ToolResult {
  return { ok: false, observation: error, error };
}
function fmtErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** 截断长文本防 token 爆炸。 */
function trunc(s: string, max = 2000): string {
  return s.length > max ? `${s.slice(0, max)}…（截断 ${s.length - max} 字符）` : s;
}
function fmtFeature(f: MapFeature, i: number): string {
  const id = f.id ?? i;
  const props = f.properties ? JSON.stringify(f.properties) : "";
  return `[${id}] ${props}`;
}

/** 地图视图操作类工具的统一提示词约束（从源头治视图抢占）。 */
const VIEW_OPS_CONSTRAINT =
  "⚠ 地图视图操作类工具（map_set_viewport/map_fly_to/map_pan_to/map_zoom_to/map_highlight）一次回答内请只调用一个；用户问题涉及多项时，分步逐个调用（调一个、观察结果后再调下一个），不要并发调用多个。";

/** 据 adapter 已实现方法生成地图工具集。 */
export function createMapTools(adapter: MapAdapter): HostToolDeclaration[] {
  const tools: HostToolDeclaration[] = [];

  // 视图抢占治理队列：闭包内每 adapter 一份，避免多地图实例（如双地图大屏）串扰。
  let chain: Promise<unknown> = Promise.resolve();
  let lastAt = 0;
  /** 操作类工具串行 + 间隔：多 execute 排队不并发，相邻至少 UI_GAP。 */
  const runUi = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(async () => {
      if (lastAt > 0) {
        const wait = UI_GAP - (Date.now() - lastAt);
        if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
      }
      lastAt = Date.now();
      return fn();
    });
    chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p as Promise<T>;
  };

  if (adapter.getViewport) {
    tools.push({
      name: "map_get_viewport",
      description: "获取地图当前视口（中心经纬度、缩放级别、可见范围 extent）。只读，不改地图。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      riskLevel: "low",
      execute: async () => {
        try {
          const vp = await adapter.getViewport!();
          return ok(
            `当前视口：center=[${vp.center.join(",")}] zoom=${vp.zoom}${vp.extent ? ` extent=[${vp.extent.join(",")}]` : ""}`,
          );
        } catch (e) {
          return fail(fmtErr(e));
        }
      },
    });
  }

  if (adapter.setViewport) {
    tools.push({
      name: "map_set_viewport",
      description: `设置地图视口（center/zoom/extent 任填，按需切换视图）。${VIEW_OPS_CONSTRAINT}`,
      inputSchema: {
        type: "object",
        properties: {
          center: { type: "array", items: { type: "number" }, description: "[经度, 纬度]" },
          zoom: { type: "number", description: "缩放级别" },
          extent: { type: "array", items: { type: "number" }, description: "[minLng,minLat,maxLng,maxLat]" },
        },
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as Partial<MapViewport>;
            await adapter.setViewport!(p);
            return ok(
              `已设置视口${p.center ? ` center=[${(p.center as LngLat).join(",")}]` : ""}${p.zoom != null ? ` zoom=${p.zoom}` : ""}`,
            );
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.flyTo) {
    tools.push({
      name: "map_fly_to",
      description: `飞至指定位置（动画切换 center/zoom）。${VIEW_OPS_CONSTRAINT}`,
      inputSchema: {
        type: "object",
        properties: {
          center: { type: "array", items: { type: "number" }, description: "[经度, 纬度]" },
          zoom: { type: "number", description: "缩放级别（可选）" },
        },
        required: ["center"],
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as { center?: LngLat; zoom?: number };
            if (!p.center) return fail("center 必填");
            await adapter.flyTo!(p);
            return ok(`已飞至 [${p.center.join(",")}]${p.zoom != null ? ` zoom=${p.zoom}` : ""}`);
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.panTo) {
    tools.push({
      name: "map_pan_to",
      description: `平移地图至指定中心（无缩放动画）。${VIEW_OPS_CONSTRAINT}`,
      inputSchema: {
        type: "object",
        properties: { center: { type: "array", items: { type: "number" }, description: "[经度, 纬度]" } },
        required: ["center"],
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as { center?: LngLat };
            if (!p.center) return fail("center 必填");
            await adapter.panTo!(p.center);
            return ok(`已平移至 [${p.center.join(",")}]`);
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.zoomTo) {
    tools.push({
      name: "map_zoom_to",
      description: `设置地图缩放级别（不改动中心）。${VIEW_OPS_CONSTRAINT}`,
      inputSchema: {
        type: "object",
        properties: { zoom: { type: "number", description: "缩放级别" } },
        required: ["zoom"],
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as { zoom?: number };
            if (p.zoom == null) return fail("zoom 必填");
            await adapter.zoomTo!(p.zoom);
            return ok(`已缩放至 ${p.zoom}`);
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.queryByExtent) {
    tools.push({
      name: "map_query_by_extent",
      description: "查询地图指定范围内的要素（矢量图层/标注等）。返回要素清单摘要。只读。",
      inputSchema: {
        type: "object",
        properties: { extent: { type: "array", items: { type: "number" }, description: "[minLng,minLat,maxLng,maxLat]" } },
        required: ["extent"],
        additionalProperties: false,
      },
      riskLevel: "low",
      execute: async (input) => {
        try {
          const p = input as { extent?: BBox };
          if (!p.extent) return fail("extent 必填");
          const features = await adapter.queryByExtent!(p.extent);
          const summary = features.map(fmtFeature).join("\n");
          return ok(`范围内 ${features.length} 个要素：\n${trunc(summary)}`);
        } catch (e) {
          return fail(fmtErr(e));
        }
      },
    });
  }

  if (adapter.getVisibleFeatures) {
    tools.push({
      name: "map_get_visible_features",
      description: "获取地图当前可见范围内的所有要素。只读。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      riskLevel: "low",
      execute: async () => {
        try {
          const features = await adapter.getVisibleFeatures!();
          const summary = features.map(fmtFeature).join("\n");
          return ok(`可见 ${features.length} 个要素：\n${trunc(summary)}`);
        } catch (e) {
          return fail(fmtErr(e));
        }
      },
    });
  }

  if (adapter.addOverlay) {
    tools.push({
      name: "map_add_overlay",
      description: "在地图上添加覆盖物（marker/线/面/圆）。返回 overlay_id 供后续移除。",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["marker", "line", "polygon", "circle"], description: "覆盖物类型" },
          coordinates: { type: ["array", "object"], description: "marker:[lng,lat]；line:[lng,lat,...]；polygon:[[lng,lat],...]；circle:{center:[lng,lat],radius:number}" },
          properties: { type: "object", description: "样式/属性（color/title 等，按地图库约定）" },
        },
        required: ["type", "coordinates"],
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as MapOverlay;
            const ref = await adapter.addOverlay!(p);
            return ok(`已添加 ${p.type} 覆盖物 id=${ref.id}`);
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.removeOverlay) {
    tools.push({
      name: "map_remove_overlay",
      description: "移除指定 id 的覆盖物。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "覆盖物 id（map_add_overlay 返回）" } },
        required: ["id"],
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as { id?: string };
            if (!p.id) return fail("id 必填");
            await adapter.removeOverlay!(p.id);
            return ok(`已移除覆盖物 ${p.id}`);
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.highlight) {
    tools.push({
      name: "map_highlight",
      description: `高亮地图上的要素（按 feature id 清单）。${VIEW_OPS_CONSTRAINT}`,
      inputSchema: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, description: "要高亮的要素 id 清单" } },
        required: ["ids"],
        additionalProperties: false,
      },
      riskLevel: "medium",
      execute: (input) =>
        runUi(async () => {
          try {
            const p = input as { ids?: string[] };
            if (!p.ids) return fail("ids 必填");
            await adapter.highlight!(p.ids);
            return ok(`已高亮 ${p.ids.length} 个要素`);
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  if (adapter.clearOverlays) {
    tools.push({
      name: "map_clear_overlays",
      description: "清除地图上所有覆盖物/高亮。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      riskLevel: "medium",
      execute: () =>
        runUi(async () => {
          try {
            await adapter.clearOverlays!();
            return ok("已清除所有覆盖物");
          } catch (e) {
            return fail(fmtErr(e));
          }
        }),
    });
  }

  return tools;
}

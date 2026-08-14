<template>
  <TooltipProvider :delay-duration="250">
    <section class="relative min-h-[32rem] w-full overflow-hidden rounded-lg border bg-muted" aria-label="地理空间地图工作台">
      <div ref="mapContainer" class="absolute inset-0" />

      <aside class="absolute bottom-3 left-3 top-3 z-10 flex w-80 flex-col overflow-hidden rounded-lg border bg-background shadow-xl max-sm:right-3 max-sm:top-auto max-sm:max-h-[46%] max-sm:w-auto">
        <header class="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <Layers3 aria-hidden="true" class="shrink-0" />
            <h2 class="truncate text-sm font-semibold">图层</h2>
            <Badge variant="secondary">{{ layerState.length }}</Badge>
          </div>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                :disabled="!combinedBounds"
                aria-label="缩放至全部图层"
                @click="fitAllLayers"
              >
                <Scan data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>缩放至全部图层</TooltipContent>
          </Tooltip>
        </header>

        <div v-if="mapError" class="shrink-0 border-b px-3 py-2">
          <Badge variant="destructive" class="max-w-full truncate">{{ mapError }}</Badge>
        </div>

        <div v-if="displayLayers.length" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <article
            v-for="layer in displayLayers"
            :key="layer.id"
            class="flex flex-col gap-3 border-b px-3 py-3.5 last:border-b-0"
          >
            <div class="flex min-w-0 items-center gap-2">
              <Switch
                :checked="layer.visible"
                :aria-label="`${layer.visible ? '隐藏' : '显示'}图层 ${layer.name}`"
                @update:checked="setLayerVisibility(layer.id, $event)"
              />
              <div class="min-w-0 flex-1">
                <div class="break-words text-sm font-medium leading-5" :title="layer.name">{{ layer.name }}</div>
                <div class="mt-1 flex items-center gap-1.5">
                  <Badge variant="outline">{{ layerTypeLabel(layer.type) }}</Badge>
                  <span class="text-xs text-muted-foreground">{{ layer.visible ? '可见' : '已隐藏' }}</span>
                </div>
                <div v-if="layer.style?.thematic" class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span v-for="stop in layer.style.thematic.stops" :key="`${stop.value}-${stop.color}`" class="inline-flex min-w-0 items-center gap-1">
                    <span class="size-2.5 shrink-0 border border-border" :style="{ backgroundColor: stop.color }" aria-hidden="true" />
                    <span class="truncate">{{ stop.label || stop.value }}</span>
                  </span>
                </div>
              </div>
            </div>

            <label class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="shrink-0">透明度</span>
              <input
                class="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="layer.opacity"
                :disabled="!layer.visible"
                :aria-label="`${layer.name} 透明度`"
                @input="handleOpacityInput(layer.id, $event)"
              >
              <output class="w-10 shrink-0 text-right tabular-nums">{{ Math.round(layer.opacity * 100) }}%</output>
            </label>

            <div class="flex items-center justify-end gap-1 border-t border-border/70 pt-2" role="group" :aria-label="`${layer.name} 操作`">
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="ghost" size="icon-sm" aria-label="定位图层" @click="fitLayer(layer.id)">
                    <LocateFixed data-icon="inline-start" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>定位图层</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :disabled="isTopLayer(layer.id)"
                    aria-label="上移图层"
                    @click="moveLayer(layer.id, layerIndex(layer.id) + 1)"
                  >
                    <ChevronUp data-icon="inline-start" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>上移图层</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :disabled="isBottomLayer(layer.id)"
                    aria-label="下移图层"
                    @click="moveLayer(layer.id, layerIndex(layer.id) - 1)"
                  >
                    <ChevronDown data-icon="inline-start" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>下移图层</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="action-danger" size="icon-sm" aria-label="移除图层" @click="removeLayer(layer.id)">
                    <Trash2 data-icon="inline-start" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>移除图层</TooltipContent>
              </Tooltip>
            </div>
          </article>
        </div>

        <Empty v-else class="min-h-0 flex-1 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Layers3 /></EmptyMedia>
            <EmptyTitle>暂无图层</EmptyTitle>
            <EmptyDescription>添加空间数据后会显示在这里</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </aside>

      <Badge v-if="!mapReady && !mapError" variant="secondary" class="absolute bottom-3 right-3">
        地图加载中
      </Badge>
    </section>
  </TooltipProvider>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ChevronDown, ChevronUp, Layers3, LocateFixed, Scan, Trash2 } from 'lucide-vue-next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  buildMapLibreLayerBundle,
  buildVectorPaintProperties,
  combineLayerBounds,
  layerSourceSignature,
  moveLayerDescriptor,
  normalizeLayerDescriptor,
  normalizeLayerDescriptors,
  resolveLayerBounds,
} from './layerDescriptors.js';

const props = defineProps({
  layers: { type: Array, default: () => [] },
  mapStyle: { type: [Object, String], default: null },
  initialView: {
    type: Object,
    default: () => ({ center: [105, 35], zoom: 3.2, bearing: 0, pitch: 0 }),
  },
  fitPadding: { type: Number, default: 56 },
  cooperativeGestures: { type: Boolean, default: true },
});

const emit = defineEmits([
  'ready',
  'error',
  'update:layers',
  'layers-change',
  'layer-added',
  'layer-removed',
]);

const mapContainer = ref(null);
const mapInstance = shallowRef(null);
const mapReady = ref(false);
const mapError = ref('');
const layerState = ref([]);
const mapRegistry = new Map();
let resizeObserver = null;

const displayLayers = computed(() => [...layerState.value].reverse());
const combinedBounds = computed(() => combineLayerBounds(layerState.value, { visibleOnly: true }));

function defaultMapStyle() {
  return {
    version: 8,
    sources: {
      'workspace-basemap': {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors',
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'workspace-background', type: 'background', paint: { 'background-color': '#f4f4f5' } },
      { id: 'workspace-basemap', type: 'raster', source: 'workspace-basemap' },
    ],
  };
}

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error || '地图操作失败');
  mapError.value = message;
  emit('error', { message, error });
}

function publishLayers(action, layerId) {
  const snapshot = layerState.value.map((layer) => ({ ...layer }));
  emit('update:layers', snapshot);
  emit('layers-change', { action, layerId, layers: snapshot });
}

function replaceLayers(layers, { publish = false, action = 'replace' } = {}) {
  try {
    layerState.value = normalizeLayerDescriptors(layers);
    mapError.value = '';
    syncMapLayers();
    if (publish) publishLayers(action);
    return listLayers();
  } catch (error) {
    reportError(error);
    return null;
  }
}

function addLayer(layer, { fit = false } = {}) {
  try {
    const normalized = normalizeLayerDescriptor(layer);
    const index = layerState.value.findIndex((item) => item.id === normalized.id);
    const next = [...layerState.value];
    if (index >= 0) next.splice(index, 1, normalized);
    else next.push(normalized);
    layerState.value = next;
    mapError.value = '';
    syncMapLayers();
    publishLayers(index >= 0 ? 'update' : 'add', normalized.id);
    if (index < 0) emit('layer-added', normalized);
    if (fit) nextTick(() => fitLayer(normalized.id));
    return normalized;
  } catch (error) {
    reportError(error);
    return null;
  }
}

function updateLayer(id, patch) {
  const current = layerState.value.find((layer) => layer.id === id);
  if (!current) return null;
  return addLayer({ ...current, ...patch, source: patch?.source ?? current.source });
}

function removeLayer(id) {
  const layer = layerState.value.find((item) => item.id === id);
  if (!layer) return false;
  layerState.value = layerState.value.filter((item) => item.id !== id);
  removeMapEntry(id);
  syncMapLayers();
  publishLayers('remove', id);
  emit('layer-removed', layer);
  return true;
}

function clearLayers() {
  if (!layerState.value.length) return;
  const ids = layerState.value.map((layer) => layer.id);
  layerState.value = [];
  ids.forEach(removeMapEntry);
  publishLayers('clear');
}

function setLayerVisibility(id, visible) {
  return updateLayer(id, { visible: Boolean(visible) });
}

function setLayerOpacity(id, opacity) {
  return updateLayer(id, { opacity: Number(opacity) });
}

function moveLayer(id, toIndex) {
  const next = moveLayerDescriptor(layerState.value, id, toIndex);
  if (!next.some((layer) => layer.id === id)) return false;
  layerState.value = next;
  syncMapLayers();
  publishLayers('reorder', id);
  return true;
}

function handleOpacityInput(id, event) {
  setLayerOpacity(id, event.target.value);
}

function layerIndex(id) {
  return layerState.value.findIndex((layer) => layer.id === id);
}

function isTopLayer(id) {
  return layerIndex(id) === layerState.value.length - 1;
}

function isBottomLayer(id) {
  return layerIndex(id) === 0;
}

function layerTypeLabel(type) {
  return { geojson: '矢量', image: '影像', raster: '瓦片' }[type] || type;
}

function removeMapEntry(id) {
  const map = mapInstance.value;
  const entry = mapRegistry.get(id);
  if (!map || !entry) return;
  [...entry.layerIds].reverse().forEach((layerId) => {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  });
  if (map.getSource(entry.sourceId)) map.removeSource(entry.sourceId);
  mapRegistry.delete(id);
}

function addMapEntry(descriptor) {
  const map = mapInstance.value;
  const bundle = buildMapLibreLayerBundle(descriptor);
  map.addSource(bundle.sourceId, bundle.source);
  bundle.layers.forEach((layer) => {
    map.addLayer({
      ...layer,
      layout: { ...(layer.layout || {}), visibility: descriptor.visible ? 'visible' : 'none' },
    });
  });
  mapRegistry.set(descriptor.id, {
    sourceId: bundle.sourceId,
    layerIds: bundle.layers.map((layer) => layer.id),
    signature: layerSourceSignature(descriptor),
  });
}

function applyLayerState(descriptor) {
  const map = mapInstance.value;
  const entry = mapRegistry.get(descriptor.id);
  if (!map || !entry) return;
  const visibility = descriptor.visible ? 'visible' : 'none';
  const paint = descriptor.type === 'geojson' ? buildVectorPaintProperties(descriptor) : null;
  entry.layerIds.forEach((layerId) => {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, 'visibility', visibility);
    const paintProperties = layerId.endsWith(':fill')
      ? paint?.fill
      : layerId.endsWith(':line')
        ? paint?.line
        : layerId.endsWith(':circle')
          ? paint?.circle
          : layerId.endsWith(':raster')
            ? { 'raster-opacity': descriptor.opacity }
            : null;
    Object.entries(paintProperties || {}).forEach(([property, value]) => {
      map.setPaintProperty(layerId, property, value);
    });
  });
}

function syncMapLayers() {
  const map = mapInstance.value;
  if (!map || !mapReady.value || !map.isStyleLoaded()) return;
  try {
    const desiredIds = new Set(layerState.value.map((layer) => layer.id));
    [...mapRegistry.keys()].forEach((id) => {
      if (!desiredIds.has(id)) removeMapEntry(id);
    });

    layerState.value.forEach((descriptor) => {
      const entry = mapRegistry.get(descriptor.id);
      const signature = layerSourceSignature(descriptor);
      if (entry && entry.signature !== signature) removeMapEntry(descriptor.id);
      if (!mapRegistry.has(descriptor.id)) addMapEntry(descriptor);
      applyLayerState(descriptor);
    });

    layerState.value.forEach((descriptor) => {
      const entry = mapRegistry.get(descriptor.id);
      entry?.layerIds.forEach((layerId) => {
        if (map.getLayer(layerId)) map.moveLayer(layerId);
      });
    });
    mapError.value = '';
  } catch (error) {
    reportError(error);
  }
}

function normalizedFitOptions(options = {}) {
  return {
    padding: Number.isFinite(options.padding) ? options.padding : props.fitPadding,
    duration: Number.isFinite(options.duration) ? options.duration : 500,
    maxZoom: Number.isFinite(options.maxZoom) ? options.maxZoom : 16,
  };
}

function fitBounds(bounds, options = {}) {
  const map = mapInstance.value;
  if (!map || !bounds) return false;
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], normalizedFitOptions(options));
  return true;
}

function fitLayer(id, options = {}) {
  const layer = layerState.value.find((item) => item.id === id);
  if (!layer) return false;
  return fitBounds(resolveLayerBounds(layer), options);
}

function fitAllLayers(options = {}) {
  return fitBounds(combinedBounds.value, options);
}

function setView(view = {}) {
  const map = mapInstance.value;
  if (!map) return false;
  map.easeTo({
    center: Array.isArray(view.center) ? view.center : map.getCenter().toArray(),
    zoom: Number.isFinite(view.zoom) ? view.zoom : map.getZoom(),
    bearing: Number.isFinite(view.bearing) ? view.bearing : map.getBearing(),
    pitch: Number.isFinite(view.pitch) ? view.pitch : map.getPitch(),
    duration: Number.isFinite(view.duration) ? view.duration : 500,
  });
  return true;
}

function getView() {
  const map = mapInstance.value;
  if (!map) return null;
  const center = map.getCenter();
  const bounds = map.getBounds();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
  };
}

function listLayers() {
  return layerState.value.map((layer) => ({ ...layer }));
}

function getMap() {
  return mapInstance.value;
}

watch(
  () => props.layers,
  (layers) => replaceLayers(layers),
  { deep: true, immediate: true },
);

onMounted(() => {
  try {
    const view = props.initialView || {};
    const map = markRaw(new maplibregl.Map({
      container: mapContainer.value,
      style: props.mapStyle || defaultMapStyle(),
      center: Array.isArray(view.center) ? view.center : [105, 35],
      zoom: Number.isFinite(view.zoom) ? view.zoom : 3.2,
      bearing: Number.isFinite(view.bearing) ? view.bearing : 0,
      pitch: Number.isFinite(view.pitch) ? view.pitch : 0,
      cooperativeGestures: props.cooperativeGestures,
      attributionControl: true,
    }));
    mapInstance.value = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.on('load', () => {
      mapReady.value = true;
      syncMapLayers();
      emit('ready', { map, layers: listLayers() });
    });
    map.on('error', (event) => reportError(event.error || new Error('地图资源加载失败')));

    resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(mapContainer.value);
  } catch (error) {
    reportError(error);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  mapRegistry.clear();
  mapInstance.value?.remove();
  mapInstance.value = null;
  mapReady.value = false;
});

defineExpose({
  addLayer,
  updateLayer,
  removeLayer,
  clearLayers,
  replaceLayers,
  listLayers,
  setLayerVisibility,
  setLayerOpacity,
  setLayerStyle: (id, style) => updateLayer(id, { style }),
  moveLayer,
  fitLayer,
  fitAllLayers,
  fitBounds,
  setView,
  getView,
  getMap,
});
</script>

<style scoped>
:deep(.maplibregl-map) {
  position: absolute;
  inset: 0;
  font-family: inherit;
}

:deep(.maplibregl-ctrl-group) {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-md);
}

:deep(.maplibregl-ctrl-group button) {
  background-color: var(--color-bg-elevated);
}

:deep(.maplibregl-ctrl-group button:hover) {
  background-color: var(--color-bg-tertiary);
}

/* maplibre 图标为黑色 sprite，深色主题需反色（token 在 main.css 按主题定义） */
:deep(.maplibregl-ctrl-icon) {
  filter: var(--map-ctrl-icon-filter, none);
}

:deep(.maplibregl-ctrl-scale) {
  border-color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-bg-elevated) 78%, transparent);
  color: var(--color-text-primary);
}
</style>

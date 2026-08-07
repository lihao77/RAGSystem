import { nextTick, onUnmounted, ref, shallowRef } from 'vue';

import { resolveArtifactLayer } from '../utils/artifactLayerRegistry.js';
import { bindArtifactMapRuntime } from '../utils/artifactMapRuntime.js';
import { normalizeLayerDescriptor } from '../components/map-workspace/layerDescriptors.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function useArtifactMapWorkspace() {
  const active = ref(false);
  const layers = ref([]);
  const mapRef = shallowRef(null);
  const resourceUrls = new Map();
  let pendingFitLayerId = null;
  let pendingView = null;

  const publishLayerPatch = (id, patch) => {
    const index = layers.value.findIndex((layer) => layer.id === id);
    if (index < 0) throw new Error(`地图图层不存在: ${id}`);
    const next = [...layers.value];
    next[index] = normalizeLayerDescriptor({ ...next[index], ...patch });
    layers.value = next;
    return next[index];
  };

  const addArtifactLayer = async (input, context = {}) => {
    const resolved = await resolveArtifactLayer(input, { signal: context.signal });
    const descriptor = normalizeLayerDescriptor(resolved.descriptor);
    const previousUrl = resourceUrls.get(descriptor.id);
    if (previousUrl && previousUrl !== resolved.resourceUrl) URL.revokeObjectURL(previousUrl);
    if (resolved.resourceUrl) resourceUrls.set(descriptor.id, resolved.resourceUrl);
    else resourceUrls.delete(descriptor.id);

    const index = layers.value.findIndex((layer) => layer.id === descriptor.id);
    const next = [...layers.value];
    if (index >= 0) next.splice(index, 1, descriptor);
    else next.push(descriptor);
    layers.value = next;
    active.value = true;
    if (input?.fit !== false) pendingFitLayerId = descriptor.id;
    await nextTick();
    if (pendingFitLayerId && mapRef.value?.fitLayer?.(pendingFitLayerId)) pendingFitLayerId = null;
    return {
      layer_id: descriptor.id,
      artifact_id: descriptor.artifactId,
      asset_id: descriptor.assetId,
      type: descriptor.type,
      title: descriptor.name,
    };
  };

  const removeLayer = ({ layer_id: id } = {}) => {
    if (!id) throw new Error('layer_id 必填');
    const exists = layers.value.some((layer) => layer.id === id);
    if (!exists) throw new Error(`地图图层不存在: ${id}`);
    layers.value = layers.value.filter((layer) => layer.id !== id);
    const url = resourceUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    resourceUrls.delete(id);
    return { layer_id: id, removed: true };
  };

  const clearLayers = () => {
    resourceUrls.forEach((url) => URL.revokeObjectURL(url));
    resourceUrls.clear();
    const count = layers.value.length;
    layers.value = [];
    return { cleared: count };
  };

  const listLayers = () => ({
    layers: layers.value.map((layer, index) => ({
      layer_id: layer.id,
      artifact_id: layer.artifactId,
      asset_id: layer.assetId,
      title: layer.name,
      type: layer.type,
      visible: layer.visible,
      opacity: layer.opacity,
      index,
    })),
  });

  const setLayerVisibility = ({ layer_id: id, visible } = {}) => ({
    layer_id: id,
    visible: publishLayerPatch(id, { visible: Boolean(visible) }).visible,
  });

  const setLayerOpacity = ({ layer_id: id, opacity } = {}) => {
    if (!Number.isFinite(Number(opacity))) throw new Error('opacity 必须是 0 到 1 的数值');
    return {
      layer_id: id,
      opacity: publishLayerPatch(id, { opacity: clamp(opacity, 0, 1) }).opacity,
    };
  };

  const setLayerStyle = ({ layer_id: id, style } = {}) => {
    const current = layers.value.find((layer) => layer.id === id);
    if (!current) throw new Error(`地图图层不存在: ${id}`);
    if (current.type !== 'geojson') throw new Error('只有 GeoJSON 图层支持专题样式');
    const layer = publishLayerPatch(id, { style });
    return { layer_id: id, style: layer.style };
  };

  const reorderLayer = ({ layer_id: id, to_index: toIndex } = {}) => {
    const fromIndex = layers.value.findIndex((layer) => layer.id === id);
    if (fromIndex < 0) throw new Error(`地图图层不存在: ${id}`);
    const next = [...layers.value];
    const [layer] = next.splice(fromIndex, 1);
    const target = clamp(toIndex, 0, next.length);
    next.splice(target, 0, layer);
    layers.value = next;
    return { layer_id: id, from_index: fromIndex, to_index: target };
  };

  const fitLayer = async ({ layer_id: id } = {}) => {
    if (!layers.value.some((layer) => layer.id === id)) throw new Error(`地图图层不存在: ${id}`);
    active.value = true;
    pendingFitLayerId = id;
    await nextTick();
    if (mapRef.value?.fitLayer?.(id)) pendingFitLayerId = null;
    return { layer_id: id, fitted: pendingFitLayerId === null };
  };

  const getViewport = () => {
    const viewport = mapRef.value?.getView?.();
    if (!viewport) throw new Error('地图尚未加载完成');
    return viewport;
  };

  const setViewport = async (input = {}) => {
    active.value = true;
    pendingView = input;
    await nextTick();
    if (mapRef.value?.setView?.(pendingView)) pendingView = null;
    return { applied: pendingView === null };
  };

  const handleMapReady = () => {
    if (pendingView && mapRef.value?.setView?.(pendingView)) pendingView = null;
    if (pendingFitLayerId && mapRef.value?.fitLayer?.(pendingFitLayerId)) pendingFitLayerId = null;
  };

  const replaceLayersFromMap = (value) => {
    layers.value = Array.isArray(value) ? value : [];
  };

  const controller = {
    addArtifactLayer,
    removeLayer,
    clearLayers,
    listLayers,
    setLayerVisibility,
    setLayerOpacity,
    setLayerStyle,
    reorderLayer,
    fitLayer,
    getViewport,
    setViewport,
  };
  const unbindRuntime = bindArtifactMapRuntime(controller);

  onUnmounted(() => {
    unbindRuntime();
    resourceUrls.forEach((url) => URL.revokeObjectURL(url));
    resourceUrls.clear();
  });

  return {
    active,
    layers,
    mapRef,
    close: () => { active.value = false; },
    handleMapReady,
    replaceLayersFromMap,
    ...controller,
  };
}

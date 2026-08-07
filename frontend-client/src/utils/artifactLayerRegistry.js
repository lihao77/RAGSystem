import { getArtifact, getArtifactAssetContent } from '../api/artifact.js';

const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_]+$/u;
const GEOJSON_MEDIA_TYPES = new Set(['application/geo+json', 'application/json']);
const DISPLAY_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const WGS84_CRS = new Set(['EPSG:4326', 'OGC:CRS84', 'CRS84']);

function requiredArtifactId(value) {
  const id = String(value || '').trim();
  if (!ARTIFACT_ID_PATTERN.test(id)) throw new Error('artifact_id 格式无效');
  return id;
}

function normalizeBounds(value) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('Artifact 缺少 metadata.spatial.bounds');
  }
  const bounds = value.map(Number);
  if (!bounds.every(Number.isFinite)) throw new Error('metadata.spatial.bounds 必须是有限数值');
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new Error('metadata.spatial.bounds 必须是 WGS84 [west,south,east,north]');
  }
  return bounds;
}

function normalizeSpatial(manifest) {
  const spatial = manifest?.metadata?.spatial;
  if (!spatial || typeof spatial !== 'object' || Array.isArray(spatial)) {
    throw new Error('Artifact 缺少 metadata.spatial 空间元数据');
  }
  const crs = String(spatial.crs || '').toUpperCase();
  if (!WGS84_CRS.has(crs)) {
    throw new Error(`地图图层只接受 WGS84 数据，当前 CRS: ${spatial.crs || 'unknown'}`);
  }
  return { ...spatial, crs: 'EPSG:4326', bounds: normalizeBounds(spatial.bounds) };
}

function validateManifest(value, artifactId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 2) {
    throw new Error('Artifact 必须是 schema_version 2 Manifest');
  }
  if (value.artifact_id !== artifactId) throw new Error('Artifact Manifest 标识不匹配');
  if (!Array.isArray(value.assets)) throw new Error('Artifact Manifest 缺少 assets');
  return value;
}

function selectAsset(manifest, assetId, predicate) {
  if (assetId) {
    const exact = manifest.assets.find((asset) => asset.asset_id === assetId);
    if (!exact) throw new Error(`Artifact 中不存在 Asset: ${assetId}`);
    return predicate(exact) ? exact : null;
  }
  return manifest.assets.find((asset) => asset.role === 'preview' && predicate(asset))
    || manifest.assets.find((asset) => asset.role === 'data' && predicate(asset))
    || manifest.assets.find(predicate)
    || null;
}

function isGeoJsonAsset(asset) {
  const mediaType = String(asset?.media_type || '').toLowerCase();
  const filename = String(asset?.filename || '').toLowerCase();
  return GEOJSON_MEDIA_TYPES.has(mediaType) && (mediaType === 'application/geo+json' || /\.(?:geojson|json)$/u.test(filename));
}

function isDisplayImageAsset(asset) {
  return DISPLAY_IMAGE_MEDIA_TYPES.has(String(asset?.media_type || '').toLowerCase());
}

async function responseText(response) {
  const value = response?.data;
  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'function') return value.text();
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  throw new Error('GeoJSON Asset 响应不是可读取文本');
}

function normalizeLayerId(value, artifactId, assetId) {
  const fallback = `${artifactId}_${assetId}`;
  const normalized = String(value || fallback).replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, 128);
  if (!normalized) throw new Error('layer_id 无效');
  return normalized;
}

function validateGeoJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Asset 不是 GeoJSON 对象');
  const supported = new Set(['Feature', 'FeatureCollection', 'GeometryCollection', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
  if (!supported.has(value.type)) throw new Error(`不支持的 GeoJSON 类型: ${value.type || 'unknown'}`);
  return value;
}

/** Resolve an Artifact V2 data asset into the single layer descriptor accepted by MapWorkspace. */
export async function resolveArtifactLayer(input, dependencies = {}) {
  const artifactId = requiredArtifactId(input?.artifact_id);
  const loadManifest = dependencies.getArtifact || getArtifact;
  const loadAsset = dependencies.getArtifactAssetContent || getArtifactAssetContent;
  const createObjectUrl = dependencies.createObjectURL || ((blob) => URL.createObjectURL(blob));
  const manifest = validateManifest(await loadManifest(artifactId), artifactId);
  const spatial = normalizeSpatial(manifest);
  const requestedAssetId = typeof input?.asset_id === 'string' ? input.asset_id.trim() : '';
  const vectorAsset = selectAsset(manifest, requestedAssetId, isGeoJsonAsset);

  if (vectorAsset) {
    const response = await loadAsset(artifactId, vectorAsset.asset_id, { signal: dependencies.signal });
    const geojson = validateGeoJson(JSON.parse(await responseText(response)));
    return {
      descriptor: {
        id: normalizeLayerId(input?.layer_id, artifactId, vectorAsset.asset_id),
        name: String(input?.title || manifest.title || vectorAsset.filename || artifactId),
        type: 'geojson',
        source: { data: geojson, generateId: true },
        bounds: spatial.bounds,
        visible: input?.visible !== false,
        opacity: input?.opacity ?? 1,
        style: input?.style,
        artifactId,
        assetId: vectorAsset.asset_id,
      },
      resourceUrl: null,
    };
  }

  const imageAsset = selectAsset(manifest, requestedAssetId, isDisplayImageAsset);
  if (imageAsset) {
    const response = await loadAsset(artifactId, imageAsset.asset_id, { signal: dependencies.signal });
    const resourceUrl = createObjectUrl(response.data);
    return {
      descriptor: {
        id: normalizeLayerId(input?.layer_id, artifactId, imageAsset.asset_id),
        name: String(input?.title || manifest.title || imageAsset.filename || artifactId),
        type: 'image',
        source: { url: resourceUrl },
        bounds: spatial.bounds,
        visible: input?.visible !== false,
        opacity: input?.opacity ?? 1,
        artifactId,
        assetId: imageAsset.asset_id,
      },
      resourceUrl,
    };
  }

  const tiles = spatial.tiles;
  if (Array.isArray(tiles) && tiles.length) {
    const assetId = requestedAssetId || manifest.assets[0]?.asset_id || 'tiles';
    return {
      descriptor: {
        id: normalizeLayerId(input?.layer_id, artifactId, assetId),
        name: String(input?.title || manifest.title || artifactId),
        type: 'raster',
        source: {
          tiles,
          tileSize: spatial.tile_size || 256,
          minzoom: spatial.min_zoom ?? 0,
          maxzoom: spatial.max_zoom ?? 22,
        },
        bounds: spatial.bounds,
        visible: input?.visible !== false,
        opacity: input?.opacity ?? 1,
        artifactId,
        assetId,
      },
      resourceUrl: null,
    };
  }

  throw new Error('Artifact 没有可显示的 GeoJSON、地理配准图片或栅格瓦片 Asset');
}

export const artifactLayerRegistryInternals = {
  normalizeBounds,
  normalizeSpatial,
  isGeoJsonAsset,
  isDisplayImageAsset,
};

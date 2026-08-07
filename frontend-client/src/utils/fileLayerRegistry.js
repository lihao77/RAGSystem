import { getWorkspaceFileContent } from '../api/workspaceFile.js';

const GEOJSON_TYPES = new Set(['FeatureCollection', 'Feature', 'GeometryCollection', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

function requiredFilePath(value) {
  const filePath = String(value || '').trim();
  if (!filePath || filePath.startsWith('/') || /^[A-Za-z]:($|[\\/])/u.test(filePath)) {
    throw new Error('file_path 必须是 workspace 内的相对路径');
  }
  if (filePath.split(/[\\/]/u).includes('..')) throw new Error('file_path 不能包含 ..');
  return filePath;
}

function normalizeBounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bounds = value.map(Number);
  return bounds.every(Number.isFinite) ? bounds : null;
}

function inferBounds(value) {
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  const visitCoordinates = (coords) => {
    if (!Array.isArray(coords)) return;
    if (coords.length >= 2 && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]))) {
      extent[0] = Math.min(extent[0], Number(coords[0]));
      extent[1] = Math.min(extent[1], Number(coords[1]));
      extent[2] = Math.max(extent[2], Number(coords[0]));
      extent[3] = Math.max(extent[3], Number(coords[1]));
      return;
    }
    coords.forEach(visitCoordinates);
  };
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'FeatureCollection') return (item.features || []).forEach(visit);
    if (item.type === 'Feature') return visit(item.geometry);
    if (item.type === 'GeometryCollection') return (item.geometries || []).forEach(visit);
    visitCoordinates(item.coordinates);
  };
  visit(value);
  return extent.every(Number.isFinite) ? extent : null;
}

async function responseText(response) {
  if (typeof response?.data === 'string') return response.data;
  if (response?.data && typeof response.data.text === 'function') return response.data.text();
  throw new Error('文件响应不是可读取文本');
}

/** Resolve a workspace GeoJSON file into a map layer descriptor. */
export async function resolveFileLayer(input, dependencies = {}) {
  const filePath = requiredFilePath(input?.file_path);
  const sessionId = String(input?.session_id || dependencies.sessionId || '').trim();
  if (!sessionId) throw new Error('session_id 必填');
  const loadFile = dependencies.getWorkspaceFileContent || getWorkspaceFileContent;
  const response = await loadFile(sessionId, filePath, { signal: dependencies.signal });
  const payload = JSON.parse(await responseText(response));
  if (!GEOJSON_TYPES.has(payload?.type)) throw new Error('文件不是支持的 GeoJSON 类型');
  const id = String(input?.layer_id || filePath.replace(/[^A-Za-z0-9_-]+/gu, '_')).slice(0, 128);
  if (!id) throw new Error('layer_id 无效');
  return {
    descriptor: {
      id,
      name: String(input?.title || filePath.split(/[\\/]/u).pop() || filePath),
      type: 'geojson',
      source: { data: payload, generateId: true },
      bounds: normalizeBounds(input?.bounds) || inferBounds(payload),
      visible: input?.visible !== false,
      opacity: input?.opacity ?? 1,
      style: input?.style,
      filePath,
    },
    resourceUrl: null,
  };
}

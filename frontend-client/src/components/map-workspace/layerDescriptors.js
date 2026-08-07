const LAYER_TYPES = new Set(['geojson', 'image', 'raster']);
const GEOJSON_TYPES = new Set([
  'Feature',
  'FeatureCollection',
  'GeometryCollection',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);
const THEMATIC_METHODS = new Set(['categorical', 'step', 'interpolate']);

const DEFAULT_VECTOR_STYLE = Object.freeze({
  fillColor: '#2563eb',
  fillOpacity: 0.28,
  lineColor: '#1d4ed8',
  lineOpacity: 0.9,
  lineWidth: 2,
  circleColor: '#dc2626',
  circleOpacity: 0.9,
  circleRadius: 5,
  circleStrokeColor: '#ffffff',
  circleStrokeWidth: 1,
});

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function optionalBounds(value, label = 'bounds') {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`${label} must be [west, south, east, north]`);
  }

  const bounds = value.map(Number);
  if (!bounds.every(Number.isFinite)) {
    throw new TypeError(`${label} must contain finite numbers`);
  }

  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) {
    throw new RangeError(`${label} must be a valid WGS84 bbox`);
  }
  return bounds;
}

function normalizeGeoJsonSource(source) {
  const data = source.data ?? source.url;
  if (typeof data !== 'string') {
    assertObject(data, 'geojson source.data');
    if (!GEOJSON_TYPES.has(data.type)) {
      throw new TypeError('geojson source.data has an unsupported GeoJSON type');
    }
  } else if (!data.trim()) {
    throw new TypeError('geojson source URL cannot be empty');
  }

  return {
    data,
    generateId: source.generateId !== false,
  };
}

function normalizeImageSource(source, bounds) {
  if (typeof source.url !== 'string' || !source.url.trim()) {
    throw new TypeError('image source.url is required');
  }
  if (!bounds) {
    throw new TypeError('image layers require WGS84 bounds');
  }
  if (bounds[0] === bounds[2] || bounds[1] === bounds[3]) {
    throw new RangeError('image layer bounds must cover a non-zero area');
  }
  return { url: source.url };
}

function normalizeRasterSource(source) {
  if (!Array.isArray(source.tiles) || !source.tiles.length || source.tiles.some((url) => typeof url !== 'string' || !url.trim())) {
    throw new TypeError('raster source.tiles must contain at least one URL template');
  }

  const tileSize = finiteNumber(source.tileSize, 256);
  if (!Number.isSafeInteger(tileSize) || tileSize < 128 || tileSize > 512) {
    throw new RangeError('raster source.tileSize must be an integer between 128 and 512');
  }

  return {
    tiles: [...source.tiles],
    tileSize,
    attribution: typeof source.attribution === 'string' ? source.attribution : undefined,
    minzoom: clamp(finiteNumber(source.minzoom, 0), 0, 24),
    maxzoom: clamp(finiteNumber(source.maxzoom, 22), 0, 24),
  };
}

function normalizeVectorStyle(value) {
  const style = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    fillColor: typeof style.fillColor === 'string' ? style.fillColor : DEFAULT_VECTOR_STYLE.fillColor,
    fillOpacity: clamp(finiteNumber(style.fillOpacity, DEFAULT_VECTOR_STYLE.fillOpacity), 0, 1),
    lineColor: typeof style.lineColor === 'string' ? style.lineColor : DEFAULT_VECTOR_STYLE.lineColor,
    lineOpacity: clamp(finiteNumber(style.lineOpacity, DEFAULT_VECTOR_STYLE.lineOpacity), 0, 1),
    lineWidth: clamp(finiteNumber(style.lineWidth, DEFAULT_VECTOR_STYLE.lineWidth), 0, 32),
    circleColor: typeof style.circleColor === 'string' ? style.circleColor : DEFAULT_VECTOR_STYLE.circleColor,
    circleOpacity: clamp(finiteNumber(style.circleOpacity, DEFAULT_VECTOR_STYLE.circleOpacity), 0, 1),
    circleRadius: clamp(finiteNumber(style.circleRadius, DEFAULT_VECTOR_STYLE.circleRadius), 1, 64),
    circleStrokeColor: typeof style.circleStrokeColor === 'string'
      ? style.circleStrokeColor
      : DEFAULT_VECTOR_STYLE.circleStrokeColor,
    circleStrokeWidth: clamp(finiteNumber(style.circleStrokeWidth, DEFAULT_VECTOR_STYLE.circleStrokeWidth), 0, 16),
    thematic: normalizeThematicStyle(style.thematic),
  };
}

function normalizeThematicStyle(value) {
  if (value == null) return undefined;
  assertObject(value, 'style.thematic');
  const field = String(value.field || '').trim();
  if (!field) throw new TypeError('style.thematic.field is required');
  const method = String(value.method || '').toLowerCase();
  if (!THEMATIC_METHODS.has(method)) throw new TypeError(`unsupported thematic method: ${method || 'empty'}`);
  if (!Array.isArray(value.stops) || !value.stops.length || value.stops.length > 24) {
    throw new TypeError('style.thematic.stops must contain 1 to 24 entries');
  }
  const stops = value.stops.map((stop, index) => {
    assertObject(stop, `style.thematic.stops[${index}]`);
    const color = String(stop.color || '').trim();
    if (!color) throw new TypeError(`style.thematic.stops[${index}].color is required`);
    const rawValue = stop.value;
    const stopValue = method === 'categorical' ? rawValue : Number(rawValue);
    if (method === 'categorical' && !['string', 'number'].includes(typeof stopValue)) {
      throw new TypeError(`style.thematic.stops[${index}].value must be a string or number`);
    }
    if (method !== 'categorical' && !Number.isFinite(stopValue)) {
      throw new TypeError(`style.thematic.stops[${index}].value must be numeric`);
    }
    return {
      value: stopValue,
      color,
      label: typeof stop.label === 'string' && stop.label.trim() ? stop.label.trim() : undefined,
    };
  });
  if (method !== 'categorical') {
    stops.sort((left, right) => left.value - right.value);
    if (new Set(stops.map((stop) => stop.value)).size !== stops.length) {
      throw new TypeError('numeric thematic stop values must be unique');
    }
  }
  if (method === 'categorical' && new Set(stops.map((stop) => typeof stop.value)).size !== 1) {
    throw new TypeError('categorical thematic stop values must use one data type');
  }
  if (method === 'interpolate' && stops.length < 2) {
    throw new TypeError('interpolate thematic styles require at least two stops');
  }
  return {
    field,
    method,
    stops,
    defaultColor: typeof value.defaultColor === 'string' && value.defaultColor.trim()
      ? value.defaultColor.trim()
      : '#94a3b8',
  };
}

export function thematicColorExpression(thematic) {
  if (!thematic) return null;
  const property = ['get', thematic.field];
  if (thematic.method === 'categorical') {
    return ['match', property, ...thematic.stops.flatMap((stop) => [stop.value, stop.color]), thematic.defaultColor];
  }
  const numericProperty = ['to-number', property];
  if (thematic.method === 'step') {
    return ['step', numericProperty, thematic.defaultColor, ...thematic.stops.flatMap((stop) => [stop.value, stop.color])];
  }
  return ['interpolate', ['linear'], numericProperty, ...thematic.stops.flatMap((stop) => [stop.value, stop.color])];
}

export function buildVectorPaintProperties(layer) {
  const descriptor = normalizeLayerDescriptor(layer);
  if (descriptor.type !== 'geojson') throw new TypeError('vector paint requires a geojson layer');
  const style = descriptor.style;
  const thematicColor = thematicColorExpression(style.thematic);
  return {
    fill: {
      'fill-color': thematicColor || style.fillColor,
      'fill-opacity': style.fillOpacity * descriptor.opacity,
    },
    line: {
      'line-color': style.lineColor,
      'line-opacity': style.lineOpacity * descriptor.opacity,
      'line-width': style.lineWidth,
    },
    circle: {
      'circle-color': thematicColor || style.circleColor,
      'circle-opacity': style.circleOpacity * descriptor.opacity,
      'circle-radius': style.circleRadius,
      'circle-stroke-color': style.circleStrokeColor,
      'circle-stroke-width': style.circleStrokeWidth,
    },
  };
}

export function normalizeLayerDescriptor(value) {
  assertObject(value, 'layer descriptor');
  const id = String(value.id ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
    throw new TypeError('layer id must contain only letters, numbers, underscores, and hyphens');
  }

  const type = String(value.type ?? '').toLowerCase();
  if (!LAYER_TYPES.has(type)) {
    throw new TypeError(`unsupported layer type: ${type || 'empty'}`);
  }

  assertObject(value.source, `${type} source`);
  const bounds = optionalBounds(value.bounds);
  const source = type === 'geojson'
    ? normalizeGeoJsonSource(value.source)
    : type === 'image'
      ? normalizeImageSource(value.source, bounds)
      : normalizeRasterSource(value.source);

  return {
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    type,
    source,
    bounds,
    visible: value.visible !== false,
    opacity: clamp(finiteNumber(value.opacity, 1), 0, 1),
    style: type === 'geojson' ? normalizeVectorStyle(value.style) : undefined,
    artifactId: typeof value.artifactId === 'string' ? value.artifactId : undefined,
    assetId: typeof value.assetId === 'string' ? value.assetId : undefined,
  };
}

export function normalizeLayerDescriptors(values) {
  if (!Array.isArray(values)) throw new TypeError('layers must be an array');
  const layers = values.map(normalizeLayerDescriptor);
  const ids = new Set();
  for (const layer of layers) {
    if (ids.has(layer.id)) throw new TypeError(`duplicate layer id: ${layer.id}`);
    ids.add(layer.id);
  }
  return layers;
}

export function boundsToImageCoordinates(bounds) {
  const [west, south, east, north] = optionalBounds(bounds);
  return [[west, north], [east, north], [east, south], [west, south]];
}

function visitCoordinates(value, extent) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    const longitude = Number(value[0]);
    const latitude = Number(value[1]);
    extent[0] = Math.min(extent[0], longitude);
    extent[1] = Math.min(extent[1], latitude);
    extent[2] = Math.max(extent[2], longitude);
    extent[3] = Math.max(extent[3], latitude);
    return;
  }
  value.forEach((item) => visitCoordinates(item, extent));
}

function visitGeoJson(value, extent) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'FeatureCollection') {
    value.features?.forEach((feature) => visitGeoJson(feature, extent));
  } else if (value.type === 'Feature') {
    visitGeoJson(value.geometry, extent);
  } else if (value.type === 'GeometryCollection') {
    value.geometries?.forEach((geometry) => visitGeoJson(geometry, extent));
  } else {
    visitCoordinates(value.coordinates, extent);
  }
}

export function inferGeoJsonBounds(value) {
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  visitGeoJson(value, extent);
  if (!extent.every(Number.isFinite)) return null;
  try {
    return optionalBounds(extent, 'GeoJSON bounds');
  } catch {
    return null;
  }
}

export function resolveLayerBounds(layer) {
  const normalized = normalizeLayerDescriptor(layer);
  if (normalized.bounds) return normalized.bounds;
  if (normalized.type === 'geojson' && typeof normalized.source.data === 'object') {
    return inferGeoJsonBounds(normalized.source.data);
  }
  return null;
}

export function combineLayerBounds(layers, { visibleOnly = false } = {}) {
  const extents = normalizeLayerDescriptors(layers)
    .filter((layer) => !visibleOnly || layer.visible)
    .map(resolveLayerBounds)
    .filter(Boolean);
  if (!extents.length) return null;
  return extents.reduce((result, extent) => [
    Math.min(result[0], extent[0]),
    Math.min(result[1], extent[1]),
    Math.max(result[2], extent[2]),
    Math.max(result[3], extent[3]),
  ]);
}

export function moveLayerDescriptor(layers, id, toIndex) {
  const normalized = normalizeLayerDescriptors(layers);
  const fromIndex = normalized.findIndex((layer) => layer.id === id);
  if (fromIndex < 0) return normalized;
  const requestedIndex = Number(toIndex);
  const target = Number.isFinite(requestedIndex)
    ? clamp(Math.trunc(requestedIndex), 0, normalized.length - 1)
    : fromIndex;
  const next = [...normalized];
  const [layer] = next.splice(fromIndex, 1);
  next.splice(target, 0, layer);
  return next;
}

export function buildMapLibreLayerBundle(layer) {
  const descriptor = normalizeLayerDescriptor(layer);
  const sourceId = `workspace-source:${descriptor.id}`;
  if (descriptor.type === 'geojson') {
    const paint = buildVectorPaintProperties(descriptor);
    return {
      sourceId,
      source: {
        type: 'geojson',
        data: descriptor.source.data,
        generateId: descriptor.source.generateId,
      },
      layers: [
        {
          id: `workspace-layer:${descriptor.id}:fill`,
          type: 'fill',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: paint.fill,
        },
        {
          id: `workspace-layer:${descriptor.id}:line`,
          type: 'line',
          source: sourceId,
          filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
          paint: paint.line,
        },
        {
          id: `workspace-layer:${descriptor.id}:circle`,
          type: 'circle',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: paint.circle,
        },
      ],
    };
  }

  if (descriptor.type === 'image') {
    return {
      sourceId,
      source: {
        type: 'image',
        url: descriptor.source.url,
        coordinates: boundsToImageCoordinates(descriptor.bounds),
      },
      layers: [{
        id: `workspace-layer:${descriptor.id}:raster`,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': descriptor.opacity },
      }],
    };
  }

  const source = {
    type: 'raster',
    tiles: descriptor.source.tiles,
    tileSize: descriptor.source.tileSize,
    minzoom: descriptor.source.minzoom,
    maxzoom: descriptor.source.maxzoom,
  };
  if (descriptor.source.attribution) source.attribution = descriptor.source.attribution;
  if (descriptor.bounds) source.bounds = descriptor.bounds;
  return {
    sourceId,
    source,
    layers: [{
      id: `workspace-layer:${descriptor.id}:raster`,
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': descriptor.opacity },
    }],
  };
}

export function layerSourceSignature(layer) {
  const descriptor = normalizeLayerDescriptor(layer);
  return JSON.stringify({ type: descriptor.type, source: descriptor.source, bounds: descriptor.bounds });
}

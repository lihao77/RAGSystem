<template>
  <div class="map-renderer">
    <div class="map-header">
      <div class="map-title">
        <span class="map-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
        </span>
        <span>{{ title }}</span>
        <span class="map-type-badge">{{ mapTypeName }}</span>
      </div>
      <div class="map-actions">
        <button v-if="!situationMode" @click="emit('enter-situation')" class="action-btn situation-btn" title="进入态势大屏">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
        </button>
        <button @click="downloadMap" class="action-btn" title="下载地图截图">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button @click="resetView" class="action-btn" title="重置视图">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
        </button>
        <button @click="toggleFullscreen" class="action-btn" title="全屏">
          <span v-if="!isFullscreen">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          </span>
          <span v-else>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
          </span>
        </button>
      </div>
    </div>
    <Teleport to="body" :disabled="!isFullscreen">
      <div
        v-if="isFullscreen"
        class="map-fullscreen-overlay"
      >
        <div class="map-fullscreen-header">
          <div class="map-title">
            <span class="map-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
            </span>
            <span>{{ title }}</span>
            <span class="map-type-badge">{{ mapTypeName }}</span>
          </div>
          <div class="map-actions">
            <button @click="downloadMap" class="action-btn" title="下载地图截图">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button @click="resetView" class="action-btn" title="重置视图">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            </button>
            <button @click="toggleFullscreen" class="action-btn close-btn" title="退出全屏">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
            </button>
          </div>
        </div>
        <div class="map-fullscreen-content">
          <div ref="fullscreenContainer" style="width:100%;height:100%;"></div>
          <div class="map-legend" v-if="mapData.value_range || mapData.risk_legend || mapData.map_type === 'choropleth'">
            <!-- 风险图例 -->
            <template v-if="mapData.map_type === 'risk' && mapData.risk_legend">
              <div class="legend-title">风险等级</div>
              <div v-for="(item, key) in mapData.risk_legend" :key="key" class="risk-legend-item">
                <span class="risk-legend-color" :style="{ background: item.color }">{{ key }}</span>
                <span class="risk-legend-label">{{ item.label }}</span>
              </div>
            </template>
            <!-- choropleth 色阶图例 -->
            <template v-else-if="mapData.map_type === 'choropleth' && mapData.color_scale">
              <div class="legend-title">{{ mapData.value_field }}</div>
              <div class="legend-choropleth">
                <span class="legend-max">{{ formatNumber(mapData.value_range?.max) }}</span>
                <div class="legend-color-bar">
                  <div v-for="(c, i) in [...mapData.color_scale.colors].reverse()" :key="i" class="legend-color-step" :style="{ background: c }"></div>
                </div>
                <span class="legend-min">{{ formatNumber(mapData.value_range?.min) }}</span>
              </div>
            </template>
            <!-- 热力图：彩色渐变条 -->
            <template v-else-if="mapData.map_type === 'heatmap' && mapData.value_range">
              <div class="legend-title">{{ mapData.value_field }}</div>
              <div class="legend-scale">
                <span class="legend-max">{{ formatNumber(mapData.value_range.max) }}</span>
                <div class="legend-gradient"></div>
                <span class="legend-min">{{ formatNumber(mapData.value_range.min) }}</span>
              </div>
            </template>
            <!-- 圆圈/点图例 -->
            <template v-else-if="mapData.value_range">
              <div class="legend-title">{{ mapData.value_field }}</div>
              <div v-if="mapData.map_type === 'circle'" class="legend-circle-demo"></div>
              <div v-else class="legend-marker-preview" v-html="getLegendMarkerPreview(mapData)"></div>
              <div class="legend-scale-row">
                <span class="legend-max">{{ formatNumber(mapData.value_range.max) }}</span>
                <span class="legend-sep">–</span>
                <span class="legend-min">{{ formatNumber(mapData.value_range.min) }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Teleport>

    <div class="map-body" v-show="!isFullscreen">
      <div ref="mapContainer" class="map-container"></div>
      <div class="map-legend" v-if="mapData.value_range || mapData.risk_legend || mapData.map_type === 'choropleth'">
        <!-- 风险图例 -->
        <template v-if="mapData.map_type === 'risk' && mapData.risk_legend">
          <div class="legend-title">风险等级</div>
          <div v-for="(item, key) in mapData.risk_legend" :key="key" class="risk-legend-item">
            <span class="risk-legend-color" :style="{ background: item.color }">{{ key }}</span>
            <span class="risk-legend-label">{{ item.label }}</span>
          </div>
        </template>
        <!-- choropleth 色阶图例 -->
        <template v-else-if="mapData.map_type === 'choropleth' && mapData.color_scale">
          <div class="legend-title">{{ mapData.value_field }}</div>
          <div class="legend-choropleth">
            <span class="legend-max">{{ formatNumber(mapData.value_range?.max) }}</span>
            <div class="legend-color-bar">
              <div v-for="(c, i) in [...mapData.color_scale.colors].reverse()" :key="i" class="legend-color-step" :style="{ background: c }"></div>
            </div>
            <span class="legend-min">{{ formatNumber(mapData.value_range?.min) }}</span>
          </div>
        </template>
        <!-- 热力图 -->
        <template v-else-if="mapData.map_type === 'heatmap' && mapData.value_range">
          <div class="legend-title">{{ mapData.value_field }}</div>
          <div class="legend-scale">
            <span class="legend-max">{{ formatNumber(mapData.value_range.max) }}</span>
            <div class="legend-gradient"></div>
            <span class="legend-min">{{ formatNumber(mapData.value_range.min) }}</span>
          </div>
        </template>
        <!-- 圆圈/点图例 -->
        <template v-else-if="mapData.value_range">
          <div class="legend-title">{{ mapData.value_field }}</div>
          <div v-if="mapData.map_type === 'circle'" class="legend-circle-demo"></div>
          <div v-else class="legend-marker-preview" v-html="getLegendMarkerPreview(mapData)"></div>
          <div class="legend-scale-row">
            <span class="legend-max">{{ formatNumber(mapData.value_range.max) }}</span>
            <span class="legend-sep">–</span>
            <span class="legend-min">{{ formatNumber(mapData.value_range.min) }}</span>
          </div>
        </template>
      </div>
    </div>
    <div class="map-footer" v-if="!isFullscreen && (mapData.total_points || mapData.total_layers)">
      <span class="map-stats" v-if="mapData.map_type === 'bindmap'">图层：{{ mapData.total_layers }} | 数据点：{{ mapData.total_points }}</span>
      <span class="map-stats" v-else-if="mapData.map_type === 'risk' && mapData.assessment_summary">
        监测点：{{ mapData.total_points }}
        <template v-for="(count, level) in mapData.assessment_summary" :key="level"> | {{ level }}级：{{ count }}</template>
      </span>
      <span class="map-stats" v-else>数据点：{{ mapData.total_points }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';

// Props
const props = defineProps({
  mapData: {
    type: Object,
    required: true,
    // Expected format:
    // {
    //   map_type: 'heatmap' | 'marker' | 'circle' | 'choropleth' | 'geojson' | 'bindmap' | 'risk',
    //   heat_data: [[lat, lng, intensity], ...],
    //   markers: [{name, lat, lng, value, radius?}, ...],
    //   geojson: { type: 'FeatureCollection', features: [...] } | null,
    //   color_scale: { type, colors } | null,
    //   layers: [...] (bindmap only),
    //   risk_legend: {...} (risk only),
    //   bounds: [[minLat, minLng], [maxLat, maxLng]],
    //   center: [lat, lng],
    //   title: string,
    //   value_field: string,
    //   total_points: number,
    //   value_range: {min, max}
    // }
  },
  title: {
    type: String,
    default: '地图可视化'
  },
  situationMode: {
    type: Boolean,
    default: false
  }
});

// Emits
const emit = defineEmits(['enter-situation', 'analyze-location']);

// State
const mapContainer = ref(null);
const fullscreenContainer = ref(null);
const mapInstance = ref(null);
const isFullscreen = ref(false);
const currentLayers = ref([]);
const layerControl = ref(null);

// Computed
const mapTypeName = ref('');

const MARKER_SIZE_MAP = { sm: 24, md: 30, lg: 36, xl: 44 };
const SUPPORTED_MARKER_ICONS = new Set(['pin', 'dot', 'ring', 'square', 'diamond', 'triangle', 'star', 'flag', 'badge', 'hospital', 'shelter', 'station', 'warning', 'rescue', 'supply', 'school', 'bridge', 'dam', 'reservoir', 'pump', 'cross', 'hexagon', 'arrow', 'shield', 'drop']);
const DEFAULT_MARKER_STYLE = {
  icon: 'pin',
  color: '#2a81cb',
  borderColor: '#1a6ab5',
  glyph: '',
  glyphColor: '#ffffff',
  size: 'md'
};

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const normalizeMarkerStyle = (style = {}) => {
  const normalized = { ...DEFAULT_MARKER_STYLE };
  if (!style || typeof style !== 'object') return normalized;

  const icon = typeof style.icon === 'string' ? style.icon.toLowerCase() : '';
  if (SUPPORTED_MARKER_ICONS.has(icon)) normalized.icon = icon;
  if (typeof style.color === 'string' && style.color) normalized.color = style.color;

  const borderColor = style.borderColor || style.border_color;
  if (typeof borderColor === 'string' && borderColor) normalized.borderColor = borderColor;

  const glyphColor = style.glyphColor || style.glyph_color;
  if (typeof glyphColor === 'string' && glyphColor) normalized.glyphColor = glyphColor;

  if (style.glyph !== undefined && style.glyph !== null) {
    normalized.glyph = String(style.glyph).slice(0, 2);
  }

  if (typeof style.size === 'number' && Number.isFinite(style.size) && style.size > 0) {
    normalized.size = style.size;
  } else if (typeof style.size === 'string') {
    const lowerSize = style.size.toLowerCase();
    if (MARKER_SIZE_MAP[lowerSize]) {
      normalized.size = lowerSize;
    } else if (/^\d+(\.\d+)?$/.test(style.size)) {
      normalized.size = Number(style.size);
    }
  }

  return normalized;
};

const getMarkerPixelSize = (size) => {
  if (typeof size === 'number' && Number.isFinite(size)) {
    return Math.max(18, Math.min(64, Math.round(size)));
  }
  return MARKER_SIZE_MAP[size] || MARKER_SIZE_MAP.md;
};

const buildMarkerSvg = (rawStyle = {}) => {
  const style = normalizeMarkerStyle(rawStyle);
  const isPin = style.icon === 'pin';
  const width = getMarkerPixelSize(style.size);
  const height = isPin ? Math.round(width * 1.3) : width;
  const viewBox = isPin ? '0 0 48 60' : '0 0 48 48';
  const glyph = escapeHtml(style.glyph || '');
  const centerMarkup = glyph
    ? `<text x="24" y="${isPin ? 24 : 28}" text-anchor="middle" font-size="${isPin ? 15 : 16}" font-weight="700" fill="${style.glyphColor}" font-family="Arial, sans-serif">${glyph}</text>`
    : `<circle cx="24" cy="${isPin ? 21 : 24}" r="5" fill="${style.glyphColor}" opacity="0.92" />`;

  let shapeMarkup = '';
  switch (style.icon) {
    case 'dot':
      shapeMarkup = `<circle cx="24" cy="24" r="18" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" />`;
      break;
    case 'ring':
      shapeMarkup = `<circle cx="24" cy="24" r="16" fill="rgba(255,255,255,0.1)" stroke="${style.color}" stroke-width="7" /><circle cx="24" cy="24" r="18" fill="none" stroke="${style.borderColor}" stroke-width="2" />`;
      break;
    case 'square':
      shapeMarkup = `<rect x="9" y="9" width="30" height="30" rx="8" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" />`;
      break;
    case 'diamond':
      shapeMarkup = `<rect x="12" y="12" width="24" height="24" rx="4" transform="rotate(45 24 24)" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" />`;
      break;
    case 'triangle':
      shapeMarkup = `<polygon points="24,8 40,38 8,38" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'star':
      shapeMarkup = `<polygon points="24,5 29.6,17 43,18.2 33,27.2 36.2,40.5 24,33.1 11.8,40.5 15,27.2 5,18.2 18.4,17" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'flag':
      shapeMarkup = `<path d="M14 6v36" stroke="${style.borderColor}" stroke-width="4" stroke-linecap="round" /><path d="M16 8h18l-4 8 4 8H16z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'badge':
      shapeMarkup = `<path d="M12 8h24a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H28l-4 8-4-8H12a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'hospital':
      shapeMarkup = `<rect x="6" y="6" width="36" height="36" rx="6" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" /><path d="M20 14v20M14 24h20" stroke="${style.glyphColor}" stroke-width="5" stroke-linecap="round" />`;
      break;
    case 'shelter':
      shapeMarkup = `<path d="M24 6L4 24h8v16h24V24h8L24 6z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'station':
      shapeMarkup = `<path d="M24 4C18 4 13 9 13 15c0 4 3 9 7 14 1.5 2 3 3.5 4 5 1-1.5 2.5-3 4-5 4-5 7-10 7-14 0-6-5-11-11-11z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" /><path d="M20 22c0-3 2-6 4-8 2 2 4 5 4 8" fill="none" stroke="${style.glyphColor}" stroke-width="2.5" stroke-linecap="round" />`;
      break;
    case 'warning':
      shapeMarkup = `<polygon points="24,5 44,40 4,40" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" /><line x1="24" y1="18" x2="24" y2="28" stroke="${style.glyphColor}" stroke-width="4" stroke-linecap="round" /><circle cx="24" cy="34" r="2.5" fill="${style.glyphColor}" />`;
      break;
    case 'rescue':
      shapeMarkup = `<circle cx="24" cy="24" r="18" fill="none" stroke="${style.color}" stroke-width="7" /><circle cx="24" cy="24" r="18" fill="none" stroke="${style.borderColor}" stroke-width="2" /><circle cx="24" cy="24" r="8" fill="${style.color}" stroke="${style.borderColor}" stroke-width="2" /><path d="M24 6v10M24 32v10M6 24h10M32 24h10" stroke="${style.color}" stroke-width="6" />`;
      break;
    case 'supply':
      shapeMarkup = `<rect x="8" y="14" width="32" height="24" rx="3" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" /><path d="M8 14l4-6h24l4 6" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" /><line x1="24" y1="14" x2="24" y2="38" stroke="${style.borderColor}" stroke-width="2" />`;
      break;
    case 'school':
      shapeMarkup = `<path d="M24 6L4 18l20 12 20-12L24 6z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" /><path d="M12 24v12l12 6 12-6V24" fill="none" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'bridge':
      shapeMarkup = `<path d="M4 32c0-10 8-18 20-18s20 8 20 18" fill="none" stroke="${style.color}" stroke-width="6" stroke-linecap="round" /><path d="M4 32c0-10 8-18 20-18s20 8 20 18" fill="none" stroke="${style.borderColor}" stroke-width="2" /><line x1="14" y1="14" x2="14" y2="32" stroke="${style.borderColor}" stroke-width="3" /><line x1="24" y1="14" x2="24" y2="32" stroke="${style.borderColor}" stroke-width="3" /><line x1="34" y1="14" x2="34" y2="32" stroke="${style.borderColor}" stroke-width="3" />`;
      break;
    case 'dam':
      shapeMarkup = `<path d="M6 12l4 28h28l4-28" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" /><path d="M6 20h36M6 28h36" stroke="${style.borderColor}" stroke-width="2" opacity="0.5" />`;
      break;
    case 'reservoir':
      shapeMarkup = `<ellipse cx="24" cy="24" rx="20" ry="14" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" /><path d="M8 20c4 4 8-4 12 0s8-4 12 0" fill="none" stroke="${style.glyphColor}" stroke-width="2.5" opacity="0.7" /><path d="M8 28c4 4 8-4 12 0s8-4 12 0" fill="none" stroke="${style.glyphColor}" stroke-width="2.5" opacity="0.7" />`;
      break;
    case 'pump':
      shapeMarkup = `<circle cx="24" cy="24" r="16" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" /><path d="M24 12v12l8 6" fill="none" stroke="${style.glyphColor}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />`;
      break;
    case 'cross':
      shapeMarkup = `<path d="M18 6h12v12h12v12H30v12H18V30H6V18h12V6z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'hexagon':
      shapeMarkup = `<polygon points="24,4 43,14 43,34 24,44 5,34 5,14" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'arrow':
      shapeMarkup = `<path d="M24 4L40 24H30v18H18V24H8L24 4z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'shield':
      shapeMarkup = `<path d="M24 4L6 12v12c0 10 8 17 18 20 10-3 18-10 18-20V12L24 4z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    case 'drop':
      shapeMarkup = `<path d="M24 4C20 12 10 20 10 28a14 14 0 0 0 28 0c0-8-10-16-14-24z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
    default:
      shapeMarkup = `<path d="M24 3C14.06 3 6 11.06 6 21c0 14.5 18 36 18 36s18-21.5 18-36C42 11.06 33.94 3 24 3z" fill="${style.color}" stroke="${style.borderColor}" stroke-width="3" stroke-linejoin="round" />`;
      break;
  }

  const svg = `<div class="custom-marker-icon" style="width:${width}px;height:${height}px;"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" fill="none" aria-hidden="true">${shapeMarkup}${centerMarkup}</svg></div>`;
  return {
    html: svg,
    iconSize: [width, height],
    iconAnchor: [Math.round(width / 2), isPin ? height - 1 : Math.round(height / 2)],
    popupAnchor: [0, isPin ? (-height + 10) : (-Math.round(height / 2))]
  };
};

const createStyledMarkerIcon = (style = {}) => {
  const svg = buildMarkerSvg(style);
  return L.divIcon({
    className: 'custom-marker-icon-wrapper',
    html: svg.html,
    iconSize: svg.iconSize,
    iconAnchor: svg.iconAnchor,
    popupAnchor: svg.popupAnchor,
  });
};

const buildMarkerPopup = (marker, valueField = '') => `
  <div class="marker-popup">
    <strong>${marker.name}</strong><br/>
    <span>${valueField || ''}: ${formatNumber(marker.value)}</span>
  </div>
`;

const createStyledMarker = (marker, layerData) => L.marker([marker.lat, marker.lng], {
  icon: createStyledMarkerIcon(marker.marker_style || layerData.marker_style || {})
}).bindPopup(buildMarkerPopup(marker, layerData.value_field || ''));

const getLegendMarkerPreview = (layerData) => buildMarkerSvg(layerData?.marker_style || {}).html;

// Methods
const initMap = (container) => {
  if (!container) return;

  // 销毁旧实例
  if (mapInstance.value) {
    mapInstance.value.remove();
    mapInstance.value = null;
  }

  // 创建地图实例
  mapInstance.value = L.map(container, {
    center: props.mapData.center || [23.5, 108.5], // 默认中心：广西
    zoom: props.mapData.map_type === 'heatmap' ? 7 : 8,
    zoomControl: true,
    attributionControl: false
  });

  // 缩放时关闭 popup，防止 divIcon 缩放动画导致 popup 偏移
  mapInstance.value.on('zoomstart', () => {
    mapInstance.value.closePopup();
  });

  // 根据主题选择瓦片源
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const tileUrl = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(mapInstance.value);

  // 根据地图类型渲染数据
  renderMapData();

  // 自动调整视图到数据范围
  if (props.mapData.bounds) {
    mapInstance.value.fitBounds(props.mapData.bounds, {
      padding: [50, 50]
    });
  }

  // 更新地图类型名称
  updateMapTypeName();
};

const renderMapData = () => {
  // 清除现有图层
  clearLayers();

  const { map_type } = props.mapData;

  if (map_type === 'bindmap') {
    renderBindmap();
  } else if (map_type === 'risk') {
    renderRiskMap();
  } else {
    renderSingleLayer(props.mapData, mapInstance.value);
  }
};

const renderSingleLayer = (layerData, map) => {
  if (!map) return;
  const { map_type, heat_data, markers, geojson } = layerData;

  if (map_type === 'heatmap' && heat_data && heat_data.length > 0) {
    const heatLayer = L.heatLayer(heat_data, {
      radius: 40,
      blur: 25,
      maxZoom: 17,
      max: 1.0,
      minOpacity: 0.6,
      gradient: {
        0.0: 'rgba(0, 0, 255, 0.8)',
        0.3: 'rgba(0, 255, 255, 0.9)',
        0.5: 'rgba(0, 255, 0, 1)',
        0.7: 'rgba(255, 255, 0, 1)',
        1.0: 'rgba(255, 0, 0, 1)'
      }
    }).addTo(map);
    currentLayers.value.push(heatLayer);
  }
  else if (map_type === 'marker' && markers && markers.length > 0) {
    markers.forEach(marker => {
      const leafletMarker = createStyledMarker(marker, layerData)
        .addTo(map);
      currentLayers.value.push(leafletMarker);
    });
  }
  else if (map_type === 'circle' && markers && markers.length > 0) {
    markers.forEach(marker => {
      const circle = L.circle([marker.lat, marker.lng], {
        radius: marker.radius || 1000,
        color: '#ff7800',
        fillColor: '#ff7800',
        fillOpacity: 0.5,
        weight: 2
      })
        .addTo(map)
        .bindPopup(`
          <div class="marker-popup">
            <strong>${marker.name}</strong><br/>
            <span>${layerData.value_field || ''}: ${formatNumber(marker.value)}</span>
          </div>
        `);
      currentLayers.value.push(circle);
    });
  }
  else if (map_type === 'choropleth' && geojson && geojson.features && geojson.features.length > 0) {
    const valueRange = layerData.value_range || { min: 0, max: 100 };
    const colorScale = layerData.color_scale;
    const geoLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const val = feature.properties?.value ?? 0;
        return {
          fillColor: getChoroplethColor(val, valueRange, colorScale),
          weight: 2,
          opacity: 1,
          color: 'rgba(255,255,255,0.5)',
          fillOpacity: 0.7,
        };
      },
      pointToLayer: (feature, latlng) => {
        return L.circleMarker(latlng, { radius: 8 });
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const lines = [`<strong>${p.name || '未命名'}</strong>`];
        if (p.value !== undefined) lines.push(`${layerData.value_field || '值'}: ${formatNumber(p.value)}`);
        Object.keys(p).forEach(k => {
          if (!['name', 'value'].includes(k)) lines.push(`${k}: ${p[k]}`);
        });
        layer.bindPopup(`<div class="marker-popup">${lines.join('<br/>')}</div>`);
      },
    }).addTo(map);
    currentLayers.value.push(geoLayer);

    // 同时渲染点标记（如果有）
    if (markers && markers.length > 0) {
      markers.forEach(marker => {
        const m = createStyledMarker(marker, layerData)
          .addTo(map);
        currentLayers.value.push(m);
      });
    }
  }
  else if (map_type === 'geojson' && geojson && geojson.features && geojson.features.length > 0) {
    const geoLayer = L.geoJSON(geojson, {
      style: () => ({
        weight: 2,
        opacity: 0.8,
        color: '#3388ff',
        fillColor: '#3388ff',
        fillOpacity: 0.3,
      }),
      pointToLayer: (feature, latlng) => {
        return L.circleMarker(latlng, {
          radius: 8, fillColor: '#3388ff', color: '#fff',
          weight: 2, fillOpacity: 0.8,
        });
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const lines = [`<strong>${p.name || '未命名'}</strong>`];
        if (p.value !== undefined) lines.push(`${layerData.value_field || '值'}: ${formatNumber(p.value)}`);
        layer.bindPopup(`<div class="marker-popup">${lines.join('<br/>')}</div>`);
      },
    }).addTo(map);
    currentLayers.value.push(geoLayer);

    // 点标记
    if (markers && markers.length > 0) {
      markers.forEach(marker => {
        const m = createStyledMarker(marker, layerData)
          .addTo(map);
        currentLayers.value.push(m);
      });
    }
  }

  return currentLayers.value;
};

const renderBindmap = () => {
  const { layers } = props.mapData;
  if (!layers || !layers.length) return;

  // 移除旧图层控件
  if (layerControl.value) {
    mapInstance.value.removeControl(layerControl.value);
    layerControl.value = null;
  }

  const overlayLayers = {};

  layers.forEach((layer) => {
    const group = L.layerGroup();
    // 临时替换 currentLayers 收集
    const savedLayers = currentLayers.value;
    currentLayers.value = [];

    // 创建虚拟 map 代理，将 addTo 重定向到 group
    const fakeMap = {
      addLayer: (l) => group.addLayer(l),
      removeLayer: (l) => group.removeLayer(l),
    };
    // renderSingleLayer 内部用 .addTo(map)，而 addTo 调用 map.addLayer
    // 因此我们用包装逻辑
    const tempLayers = [];
    const origPush = Array.prototype.push;

    // 渲染到 group
    renderSingleLayerToGroup(layer, group);

    currentLayers.value = savedLayers;
    currentLayers.value.push(group);

    overlayLayers[layer.label || `图层 ${layer.id}`] = group;

    if (layer.visible !== false) {
      group.addTo(mapInstance.value);
    }
  });

  layerControl.value = L.control.layers(null, overlayLayers, { collapsed: false }).addTo(mapInstance.value);
};

const renderSingleLayerToGroup = (layerData, group) => {
  const { map_type, heat_data, markers, geojson, value_field, value_range, color_scale } = layerData;

  if (map_type === 'heatmap' && heat_data && heat_data.length > 0) {
    const heatLayer = L.heatLayer(heat_data, {
      radius: 40, blur: 25, maxZoom: 17, max: 1.0, minOpacity: 0.6,
      gradient: { 0.0: 'rgba(0,0,255,0.8)', 0.3: 'rgba(0,255,255,0.9)', 0.5: 'rgba(0,255,0,1)', 0.7: 'rgba(255,255,0,1)', 1.0: 'rgba(255,0,0,1)' }
    });
    group.addLayer(heatLayer);
  }
  if ((map_type === 'marker' || map_type === 'circle') && markers && markers.length > 0) {
    markers.forEach(marker => {
      if (map_type === 'circle') {
        group.addLayer(L.circle([marker.lat, marker.lng], {
          radius: marker.radius || 1000, color: '#ff7800', fillColor: '#ff7800', fillOpacity: 0.5, weight: 2
        }).bindPopup(`<div class="marker-popup"><strong>${marker.name}</strong><br/>${value_field || ''}: ${formatNumber(marker.value)}</div>`));
      } else {
        group.addLayer(createStyledMarker(marker, layerData));
      }
    });
  }
  if ((map_type === 'choropleth' || map_type === 'geojson') && geojson && geojson.features) {
    const isChoropleth = map_type === 'choropleth';
    const vr = value_range || { min: 0, max: 100 };
    group.addLayer(L.geoJSON(geojson, {
      style: (feature) => isChoropleth ? {
        fillColor: getChoroplethColor(feature.properties?.value ?? 0, vr, color_scale),
        weight: 2, opacity: 1, color: 'rgba(255,255,255,0.5)', fillOpacity: 0.7,
      } : { weight: 2, opacity: 0.8, color: '#3388ff', fillColor: '#3388ff', fillOpacity: 0.3 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 8 }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindPopup(`<div class="marker-popup"><strong>${p.name || '未命名'}</strong><br/>${value_field || '值'}: ${formatNumber(p.value)}</div>`);
      },
    }));

    if (markers && markers.length > 0) {
      markers.forEach(marker => {
        group.addLayer(createStyledMarker(marker, layerData));
      });
    }
  }
};

const renderRiskMap = () => {
  const { markers } = props.mapData;
  if (!markers || !markers.length) return;

  const RISK_COLORS = { 'I': '#d32f2f', 'II': '#ff9800', 'III': '#fdd835', 'IV': '#1976d2' };

  markers.forEach(marker => {
    const color = marker.risk_color || RISK_COLORS[marker.risk_level] || '#999';
    const riskLevel = marker.risk_level || '?';

    const icon = L.divIcon({
      className: 'risk-marker-icon',
      html: `<div style="background:${color};width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:12px;border:3px solid rgba(255,255,255,0.8);box-shadow:0 2px 8px rgba(0,0,0,0.3);">${riskLevel}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    const m = L.marker([marker.lat, marker.lng], { icon })
      .addTo(mapInstance.value);

    // 构建弹出框（所有用户数据经 escapeHtml 转义防 XSS）
    const safeName = escapeHtml(marker.name);
    const safeAssessment = escapeHtml(marker.assessment || '');
    const factors = marker.risk_factors || [];
    let popupHtml = `<div class="marker-popup risk-popup">`;
    popupHtml += `<strong>${safeName}</strong>`;
    popupHtml += `<span class="risk-badge" style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;margin-left:6px;font-size:0.75rem;">${riskLevel}级</span><br/>`;
    if (safeAssessment) popupHtml += `<div style="margin:4px 0;font-size:0.85rem;">${safeAssessment}</div>`;
    if (factors.length) {
      popupHtml += `<div style="margin-top:4px;font-size:0.8rem;color:#666;">`;
      factors.forEach(f => { popupHtml += `<div>· ${escapeHtml(f)}</div>`; });
      popupHtml += `</div>`;
    }
    popupHtml += `<div style="margin-top:6px;"><button class="risk-analyze-btn" data-location="${safeName}" style="background:${color};color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:0.8rem;">深入分析</button></div>`;
    popupHtml += `</div>`;
    m.bindPopup(popupHtml);

    // 绑定点击事件（用 popup DOM 内查找，避免全局 querySelector 匹配错误）
    m.on('popupopen', () => {
      const popup = m.getPopup();
      const container = popup?.getElement();
      const btn = container?.querySelector('.risk-analyze-btn');
      if (btn) {
        btn.onclick = () => emit('analyze-location', marker.name);
      }
    });

    currentLayers.value.push(m);
  });
};

const getChoroplethColor = (value, valueRange, colorScale) => {
  const colors = colorScale?.colors || ['#ffffcc', '#fd8d3c', '#e31a1c', '#800026'];
  const min = valueRange?.min ?? 0;
  const max = valueRange?.max ?? 100;
  if (max <= min) return colors[0];
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const idx = Math.min(Math.floor(ratio * colors.length), colors.length - 1);
  return colors[idx];
};

const clearLayers = () => {
  currentLayers.value.forEach(layer => {
    if (mapInstance.value) {
      mapInstance.value.removeLayer(layer);
    }
  });
  currentLayers.value = [];
  if (layerControl.value && mapInstance.value) {
    mapInstance.value.removeControl(layerControl.value);
    layerControl.value = null;
  }
};

const updateMapTypeName = () => {
  const typeNames = {
    'heatmap': '热力图',
    'marker': '标记点',
    'circle': '圆圈标记',
    'choropleth': '区域填色',
    'geojson': 'GeoJSON',
    'bindmap': '多图层',
    'risk': '风险评估'
  };
  mapTypeName.value = typeNames[props.mapData.map_type] || '地图';
};

const toggleFullscreen = async () => {
  isFullscreen.value = !isFullscreen.value;

  // 等待 DOM 更新
  await nextTick();

  // 根据全屏状态重新初始化地图到正确的容器
  const targetContainer = isFullscreen.value ? fullscreenContainer.value : mapContainer.value;
  if (targetContainer) {
    initMap(targetContainer);
  }
};

const resetView = () => {
  if (mapInstance.value && props.mapData.bounds) {
    mapInstance.value.fitBounds(props.mapData.bounds, {
      padding: [50, 50],
      animate: true
    });
  }
};

const downloadMap = async () => {
  // 使用 html2canvas 或 Leaflet Image 插件来截图
  // 这里提供一个简单的提示
  alert('地图下载功能需要额外的截图库支持（如 leaflet-image），当前版本暂未实现。');
};

const formatNumber = (num) => {
  if (num === null || num === undefined) return '-';
  if (num >= 10000) {
    return (num / 10000).toFixed(2) + '万';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(2) + '千';
  }
  return num.toFixed(2);
};

// Lifecycle
let themeObserver = null;

onMounted(() => {
  initMap(mapContainer.value);

  // 监听主题切换，重新初始化地图以更换瓦片
  themeObserver = new MutationObserver(() => {
    const container = isFullscreen.value ? fullscreenContainer.value : mapContainer.value;
    initMap(container);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  if (mapInstance.value) {
    mapInstance.value.remove();
    mapInstance.value = null;
  }
});

// Watch for data changes
watch(() => props.mapData, () => {
  if (mapInstance.value) {
    renderMapData();
    if (props.mapData.bounds) {
      mapInstance.value.fitBounds(props.mapData.bounds, {
        padding: [50, 50]
      });
    }
    updateMapTypeName();
  }
}, { deep: true });
</script>

<style scoped>
.map-renderer {
  width: 100%;
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  border-radius: var(--radius-lg);
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--color-border);
  transition: all 0.3s;
}

.map-renderer:hover {
  background: var(--color-bg-secondary);
  border-color: var(--color-border-hover);
}

.map-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  transition: all 0.2s;
  gap: var(--spacing-sm);
  min-width: 0;
  position: relative;
  z-index: 600; /* 高于 Leaflet 最高层 pane（z-index 400~500） */
}

.map-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-primary);
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.map-title > span:not(.map-icon):not(.map-type-badge) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.map-icon {
  font-size: 1rem;
  opacity: 0.9;
}

.map-type-badge {
  padding: 4px 12px;
  background: var(--color-interactive-subtle);
  color: var(--color-brand-accent-light);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  border: 1px solid var(--color-border);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.map-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.action-btn {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  padding: 6px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
}

.action-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-hover);
  color: var(--color-text-primary);
  /* transform: translateY(-1px); */
}

.action-btn:active {
  transform: translateY(0);
}

.situation-btn {
  background: rgba(33, 150, 243, 0.1);
  border-color: rgba(33, 150, 243, 0.3);
  color: var(--color-brand-accent-light, #64b5f6);
}

.situation-btn:hover {
  background: rgba(33, 150, 243, 0.2);
  border-color: rgba(33, 150, 243, 0.5);
}

.map-body {
  position: relative;
}

.map-container {
  width: 100%;
  height: 500px;
  position: relative;
  background: var(--color-bg-primary);
  z-index: 1;
}

.map-legend {
  position: absolute;
  bottom: 16px;
  right: 16px;
  z-index: 500; /* 在 Leaflet 控件之上 */
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--glass-bg);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.legend-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  margin-bottom: 2px;
}

.legend-scale {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.legend-min,
.legend-max {
  font-size: 0.65rem;
  color: var(--color-text-secondary);
  line-height: 1;
}

.legend-gradient {
  width: 12px;
  height: 60px;
  background: linear-gradient(to bottom,
    rgba(255, 0, 0, 0.9),
    rgba(255, 255, 0, 0.9),
    rgba(0, 255, 0, 0.9),
    rgba(0, 255, 255, 0.9),
    rgba(0, 0, 255, 0.9)
  );
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.legend-circle-demo {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(255, 120, 0, 0.5);
  border: 2px solid #ff7800;
  flex-shrink: 0;
}

.legend-marker-preview {
  min-width: 28px;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.legend-scale-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.65rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.legend-sep {
  color: var(--color-text-muted);
}

.map-stats {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.map-footer {
  display: flex;
  align-items: center;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
}

/* 响应式：平板端收缩高度 */
@media (max-width: 1024px) and (min-width: 768px) {
  .map-container {
    height: 420px;
  }
}

/* 响应式：移动端大幅收缩高度，适合竖屏 */
@media (max-width: 767px) {
  .map-container {
    height: 300px;
  }

  .map-header {
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .map-footer {
    padding: var(--spacing-sm);
  }

  .map-type-badge {
    display: none;
  }

  .map-legend {
    bottom: 10px;
    right: 10px;
    padding: var(--spacing-xs) var(--spacing-sm);
  }

  .legend-gradient {
    height: 44px;
  }

  .map-fullscreen-header {
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .map-fullscreen-header .map-type-badge {
    display: none;
  }
}

.map-fullscreen-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: var(--z-toast);
  background: var(--color-bg-app);
  display: flex;
  flex-direction: column;
}

.map-fullscreen-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  position: relative;
  z-index: 600;
}

.map-fullscreen-content {
  flex: 1;
  width: 100%;
  position: relative;
  overflow: hidden;
}

.close-btn {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
}
.close-btn:hover {
    background: var(--color-error-bg);
    color: var(--color-error);
    border-color: var(--color-error);
}

/* Leaflet 弹出窗口样式 */
:deep(.marker-popup) {
  font-family: var(--font-sans);
  padding: var(--spacing-xs);
}

:deep(.marker-popup strong) {
  display: block;
  margin-bottom: var(--spacing-xs);
  color: var(--color-text-primary);
}

:deep(.marker-popup span) {
  color: var(--color-text-secondary);
  font-size: 0.8rem;
}

/* Risk Legend */
.risk-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}

.risk-legend-color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.65rem;
  font-weight: bold;
  flex-shrink: 0;
}

.risk-legend-label {
  font-size: 0.7rem;
  color: var(--color-text-secondary);
}

/* Choropleth Legend */
.legend-choropleth {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.legend-color-bar {
  display: flex;
  flex-direction: column;
  width: 16px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.legend-color-step {
  width: 100%;
  height: 16px;
}

/* Custom marker icon - prevent leaflet default sizing */
:deep(.custom-marker-icon-wrapper),
:deep(.risk-marker-icon) {
  background: none !important;
  border: none !important;
}

:deep(.custom-marker-icon) {
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.custom-marker-icon svg) {
  overflow: visible;
  filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.28));
}

/* Risk popup analyze button hover */
:deep(.risk-analyze-btn:hover) {
  opacity: 0.85;
  filter: brightness(1.1);
}

/* Leaflet 图层控件样式 */
:deep(.leaflet-control-layers) {
  background: var(--glass-bg) !important;
  backdrop-filter: blur(5px);
  border: 1px solid var(--color-border) !important;
  border-radius: var(--radius-md) !important;
  box-shadow: var(--shadow-md) !important;
  color: var(--color-text-primary) !important;
  padding: var(--spacing-sm) !important;
}

:deep(.leaflet-control-layers label) {
  color: var(--color-text-primary) !important;
  font-size: 0.8rem;
}

/* Leaflet 控件样式 - 深色主题 */
:deep(.leaflet-control-zoom a) {
  background: var(--color-bg-secondary) !important;
  border: 1px solid var(--color-border) !important;
  color: var(--color-text-primary) !important;
}

:deep(.leaflet-control-zoom a:hover) {
  background: var(--color-bg-tertiary) !important;
  border-color: var(--color-border-hover) !important;
}

:deep(.leaflet-bar) {
  border: 1px solid var(--color-border) !important;
  box-shadow: var(--shadow-md) !important;
}

:deep(.leaflet-popup-content-wrapper) {
  background: var(--color-bg-secondary) !important;
  color: var(--color-text-primary) !important;
  border: 1px solid var(--color-border) !important;
  border-radius: var(--radius-md) !important;
}

:deep(.leaflet-popup-tip) {
  background: var(--color-bg-secondary) !important;
  border: 1px solid var(--color-border) !important;
}
</style>


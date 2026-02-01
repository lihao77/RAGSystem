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
        <div ref="fullscreenContainer" class="map-fullscreen-content"></div>
        <!-- 这里的 legend 是全屏模式下的 -->
        <div class="map-legend fullscreen-legend" v-if="mapData.value_range">
          <div class="legend-title">{{ mapData.value_field }}</div>
          <div class="legend-scale">
            <span class="legend-min">{{ formatNumber(mapData.value_range.min) }}</span>
            <div class="legend-gradient"></div>
            <span class="legend-max">{{ formatNumber(mapData.value_range.max) }}</span>
          </div>
          <div class="map-stats">
            <span>数据点：{{ mapData.total_points }}</span>
          </div>
        </div>
      </div>
    </Teleport>

    <div
      ref="mapContainer"
      class="map-container"
      v-show="!isFullscreen"
    ></div>
    <div class="map-legend" v-if="mapData.value_range">
      <div class="legend-title">{{ mapData.value_field }}</div>
      <div class="legend-scale">
        <span class="legend-min">{{ formatNumber(mapData.value_range.min) }}</span>
        <div class="legend-gradient"></div>
        <span class="legend-max">{{ formatNumber(mapData.value_range.max) }}</span>
      </div>
      <div class="map-stats">
        <span>数据点：{{ mapData.total_points }}</span>
      </div>
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
    //   map_type: 'heatmap' | 'marker' | 'circle',
    //   heat_data: [[lat, lng, intensity], ...],
    //   markers: [{name, lat, lng, value, radius?}, ...],
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
  }
});

// State
const mapContainer = ref(null);
const fullscreenContainer = ref(null);
const mapInstance = ref(null);
const isFullscreen = ref(false);
const currentLayers = ref([]);

// Computed
const mapTypeName = ref('');

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
    attributionControl: true
  });

  // 添加瓦片图层 (OpenStreetMap)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors',
    maxZoom: 18
  }).addTo(mapInstance.value);

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

  const { map_type, heat_data, markers } = props.mapData;

  if (map_type === 'heatmap' && heat_data && heat_data.length > 0) {
    // 渲染热力图
    const heatLayer = L.heatLayer(heat_data, {
      radius: 40,
      blur: 25,
      maxZoom: 17,
      max: 1.0,
      minOpacity: 0.6,    // 增加最小不透明度
      gradient: {
        0.0: 'rgba(0, 0, 255, 0.8)',      // 蓝色，80%不透明
        0.3: 'rgba(0, 255, 255, 0.9)',    // 青色，90%不透明
        0.5: 'rgba(0, 255, 0, 1)',        // 绿色，100%不透明
        0.7: 'rgba(255, 255, 0, 1)',      // 黄色，100%不透明
        1.0: 'rgba(255, 0, 0, 1)'         // 红色，100%不透明
      }
    }).addTo(mapInstance.value);
    currentLayers.value.push(heatLayer);
  }
  else if (map_type === 'marker' && markers && markers.length > 0) {
    // 渲染标记点
    markers.forEach(marker => {
      const leafletMarker = L.marker([marker.lat, marker.lng])
        .addTo(mapInstance.value)
        .bindPopup(`
          <div class="marker-popup">
            <strong>${marker.name}</strong><br/>
            <span>${props.mapData.value_field}: ${formatNumber(marker.value)}</span>
          </div>
        `);
      currentLayers.value.push(leafletMarker);
    });
  }
  else if (map_type === 'circle' && markers && markers.length > 0) {
    // 渲染圆圈标记
    markers.forEach(marker => {
      const circle = L.circle([marker.lat, marker.lng], {
        radius: marker.radius || 1000,
        color: '#ff7800',
        fillColor: '#ff7800',
        fillOpacity: 0.5,
        weight: 2
      })
        .addTo(mapInstance.value)
        .bindPopup(`
          <div class="marker-popup">
            <strong>${marker.name}</strong><br/>
            <span>${props.mapData.value_field}: ${formatNumber(marker.value)}</span>
          </div>
        `);
      currentLayers.value.push(circle);
    });
  }
};

const clearLayers = () => {
  currentLayers.value.forEach(layer => {
    if (mapInstance.value) {
      mapInstance.value.removeLayer(layer);
    }
  });
  currentLayers.value = [];
};

const updateMapTypeName = () => {
  const typeNames = {
    'heatmap': '热力图',
    'marker': '标记点',
    'circle': '圆圈标记'
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
onMounted(() => {
  initMap(mapContainer.value);
});

onBeforeUnmount(() => {
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
  transition: all var(--transition-normal);
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
  transition: all var(--transition-fast);
}

.map-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.map-icon {
  font-size: 1rem;
  opacity: 0.9;
}

.map-type-badge {
  padding: 4px 12px;
  background: var(--color-interactive-subtle);
  color: var(--color-interactive);
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
  transition: all var(--transition-fast);
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

.map-container {
  width: 100%;
  height: 500px;
  position: relative;
  transition: all var(--transition-normal);
  background: var(--color-bg-primary);
  z-index: 1;
}

.map-fullscreen-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
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
}

.map-fullscreen-content {
  flex: 1;
  width: 100%;
  height: 100%;
  position: relative;
  /* 确保地图容器占满剩余空间 */
}

.fullscreen-legend {
  position: absolute;
  bottom: 20px;
  right: 20px;
  z-index: 1000; /* 确保在地图之上 */
  background: rgba(24, 24, 27, 0.8); /* 半透明背景 */
  backdrop-filter: blur(10px);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--color-border);
  min-width: 200px;
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

.map-legend {
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
}

.legend-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-sm);
}

.legend-scale {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
}

.legend-min,
.legend-max {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  min-width: 50px;
}

.legend-gradient {
  flex: 1;
  height: 20px;
  background: linear-gradient(to right,
    rgba(0, 0, 255, 0.9),
    rgba(0, 255, 255, 0.9),
    rgba(0, 255, 0, 0.9),
    rgba(255, 255, 0, 0.9),
    rgba(255, 0, 0, 0.9)
  );
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
}

.map-stats {
  font-size: 0.75rem;
  color: var(--color-text-muted);
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
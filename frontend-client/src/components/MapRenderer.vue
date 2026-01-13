<template>
  <div class="map-renderer">
    <div class="map-header">
      <div class="map-title">
        <span class="map-icon">🗺️</span>
        <span>{{ title }}</span>
        <span class="map-type-badge">{{ mapTypeName }}</span>
      </div>
      <div class="map-actions">
        <button @click="toggleFullscreen" class="action-btn" title="全屏">
          <span v-if="!isFullscreen">⛶</span>
          <span v-else>⛶</span>
        </button>
        <button @click="downloadMap" class="action-btn" title="下载地图截图">💾</button>
        <button @click="resetView" class="action-btn" title="重置视图">🔄</button>
      </div>
    </div>
    <div
      ref="mapContainer"
      class="map-container"
      :class="{ 'fullscreen': isFullscreen }"
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
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
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
const mapInstance = ref(null);
const isFullscreen = ref(false);
const currentLayers = ref([]);

// Computed
const mapTypeName = ref('');

// Methods
const initMap = () => {
  if (!mapContainer.value) return;

  // 创建地图实例
  mapInstance.value = L.map(mapContainer.value, {
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

const toggleFullscreen = () => {
  isFullscreen.value = !isFullscreen.value;

  // 等待 DOM 更新后刷新地图尺寸
  setTimeout(() => {
    if (mapInstance.value) {
      mapInstance.value.invalidateSize();
    }
  }, 100);
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
  initMap();
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
  background: white;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin-bottom: 16px;
  border: 1px solid var(--color-border);
}

.map-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--color-bg-sidebar);
  color: var(--color-text-main);
  border-bottom: 1px solid var(--color-border);
}

.map-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
}

.map-icon {
  font-size: 20px;
}

.map-type-badge {
  padding: 2px 8px;
  background: var(--color-primary-light);
  color: var(--color-primary);
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.map-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-btn:hover {
  background: var(--color-bg-app);
  color: var(--color-text-main);
}

.map-container {
  width: 100%;
  height: 500px;
  position: relative;
  transition: all 0.3s ease;
}

.map-container.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: white;
}

.map-legend {
  padding: 12px 16px;
  background: var(--color-bg-app);
  border-top: 1px solid var(--color-border);
}

.legend-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
  margin-bottom: 8px;
}

.legend-scale {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.legend-min,
.legend-max {
  font-size: 12px;
  color: var(--color-text-muted);
  min-width: 50px;
}

.legend-gradient {
  flex: 1;
  height: 20px;
  background: linear-gradient(to right, blue, cyan, lime, yellow, red);
  border-radius: 4px;
}

.map-stats {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* Leaflet 弹出窗口样式 */
:deep(.marker-popup) {
  font-family: inherit;
  padding: 4px;
}

:deep(.marker-popup strong) {
  display: block;
  margin-bottom: 4px;
  color: var(--color-text-main);
}

:deep(.marker-popup span) {
  color: var(--color-text-secondary);
  font-size: 13px;
}
</style>
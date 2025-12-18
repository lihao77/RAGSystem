<template>
  <div class="split-container">
    <!-- 地图作为底层 -->
    <div class="map-section">
      <MapView @select-entity="handleEntitySelected" @reset-view="handleResetView" ref="mapViewRef" />
    </div>

    <!-- 关系图谱作为浮动面板叠加在地图上 -->
    <div class="graph-overlay-panel" v-if="showGraphPanel">
      <button class="close-btn" @click="closeGraphPanel" title="关闭">✕</button>
      <div class="graph-panel-body">
        <RelationshipGraph :view-mode="'overlay'" :entity-id="selectedEntityId" @select-entity="handleEntitySelected" />
        
        <!-- 图例 -->
        <div class="legend-panel graph-legend">
          <div class="legend-items">
            <div class="legend-item">
              <span class="legend-dot" style="background: #ff5722;"></span>
              <span class="legend-label">地点</span>
            </div>
            <div class="legend-item">
              <span class="legend-dot" style="background: #4caf50;"></span>
              <span class="legend-label">设施</span>
            </div>
            <div class="legend-item">
              <span class="legend-dot" style="background: #2196f3;"></span>
              <span class="legend-label">状态</span>
            </div>
            <div class="legend-item">
              <span class="legend-dot" style="background: #ffc107;"></span>
              <span class="legend-label">事件</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="loading" class="loading-overlay">
      <div class="spinner"></div>
      <div class="loading-text">加载中...</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import MapView from '../components/visualization/MapView.vue';
import RelationshipGraph from '../components/visualization/RelationshipGraph.vue';
import { entityService } from '../api';

defineOptions({ name: 'SplitView' });

// 响应式状态
const selectedEntityId = ref(null);
const loading = ref(true);
const selectEntity = ref(null);
const showGraphPanel = ref(true); // 控制图谱面板显示/隐藏
// 初始化
onMounted(() => {
  // 模拟加载完成
  setTimeout(() => {
    loading.value = false;
  }, 2000);
});


// 处理实体选择
const handleEntitySelected = async (entity) => {
  selectedEntityId.value = entity.id;
  selectEntity.value = entity;
  showGraphPanel.value = true; // 选中实体时显示图谱面板
  console.log('选中实体:', entity);
  if (entity.type === '事件') {
    await handleFocusEvent(entity);
  }
  if (entity.type === '地点' || entity.type === '设施') {
    await handleFocusLocation(entity);
  }
  if (entity.type === 'State') {
    await handleFocusState(entity);
  }


};

// 获取MapView组件引用
const mapViewRef = ref(null);

// 获取事件发生地点
const handleFocusEvent = async (eventNode) => {
  try {
    // 获取事件发生地点
    const res = await entityService.getEventLocations(eventNode.id);
    const entity = res.entities;
    const relationships = res.relationships;
    console.log(res)

    const eventN = {
      id: eventNode.id,
      name: eventNode.name,
      type: eventNode.type,
      longitude: 24.32, // 默认经度
      latitude: 109.42, // 默认纬度
    }
    if (entity && entity.length > 0) {
      // 计算所有地点的中心位置
      const validLocations = entity.filter(loc => loc.longitude && loc.latitude);

      if (validLocations.length > 0) {
        // 计算中心点
        const sumLon = validLocations.reduce((sum, loc) => sum + loc.longitude, 0);
        const sumLat = validLocations.reduce((sum, loc) => sum + loc.latitude, 0);
        eventN.longitude = sumLon / validLocations.length;
        eventN.latitude = sumLat / validLocations.length;
      }
    }
    // res.entities.push(eventN);

    mapViewRef.value.loadSelectData(res, eventN.type);
    // mapViewRef.value.flyToLocation(eventN.longitude, eventN.latitude);
    mapViewRef.value.updateSelectedEntity(eventN);
  } catch (err) {
    console.error('获取事件地点错误:', err);
  }
};

// 获取地点层级结构
const handleFocusLocation = async (locationNode) => {
  try {
    // 获取地点层级结构
    const res = await entityService.getLocationHierarchy(locationNode.id);
    const entity = res.entities;
    const relationships = res.relationships;

    // 加载地图数据
    mapViewRef.value.loadSelectData(res, locationNode.type);
    // 更新选中实体
    mapViewRef.value.updateSelectedEntity(locationNode);
  } catch (err) {
    console.error('获取地点层级结构错误:', err);
  }
};

const handleFocusState = async (stateNode) => {
  mapViewRef.value.selectState(stateNode);
}

// 关闭图谱面板
const closeGraphPanel = () => {
  showGraphPanel.value = false;
  selectedEntityId.value = null;
};

// 处理MapView组件发出的reset-view事件
const handleResetView = () => {
  // 清除选中的实体ID，这将触发RelationshipGraph组件显示完整图谱
  selectedEntityId.value = null;
};
</script>

<style scoped>
/* 应用容器 */
.split-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 地图作为底层，充满整个容器 */
.map-section {
  width: 100%;
  height: 100%;
  position: relative;
}

/* 关系图谱浮动面板 - 类似状态树的设计 */
.graph-overlay-panel {
  position: absolute;
  bottom: 20px;
  right: 20px;
  width: 480px;
  height: calc(50% - 40px);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(250, 251, 252, 0.98) 100%);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.8);
  z-index: 800;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideInRight 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes slideInRight {
  from {
    opacity: 0;
    transform: translateX(30px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 图谱面板头部 */
.graph-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%);
  color: white;
  border-radius: 16px 16px 0 0;
  box-shadow: 0 2px 8px rgba(24, 144, 255, 0.2);
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.close-btn {
  z-index: 999;
  width: 32px;
  height: 32px;
  position: absolute;
  top: 10px;
  right: 10px;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  color: rgb(0, 0, 0);
  cursor: pointer;
  font-size: 18px;
  font-weight: 500;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: scale(1.05);
}

.close-btn:active {
  transform: scale(0.95);
}

/* 图谱面板内容区 */
.graph-panel-body {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: #f8f9fb;
}

/* 图例面板样式 */
.legend-panel {
  position: absolute;
  bottom: 6px;
  right: 6px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(250, 251, 252, 0.95) 100%);
  border-radius: 12px;
  padding: 12px 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.04);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.8);
  z-index: 10;
  animation: fadeIn 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  /* min-width: 140px; */
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.legend-title {
  font-size: 13px;
  font-weight: 600;
  color: #2c3e50;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 2px solid #e3e8ef;
}

.legend-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.legend-item:hover {
  background: #f8f9fb;
}

.legend-icon {
  font-size: 16px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  border: 2px solid white;
}

.legend-label {
  font-size: 12px;
  color: #2c3e50;
  font-weight: 500;
}

/* 加载中样式 - 优化 */
.loading-overlay {
  height: 100%;
  width: 100%;
  position: absolute;
  top: 0;
  left: 0;
  background: linear-gradient(135deg, rgba(26, 35, 126, 0.95) 0%, rgba(40, 53, 147, 0.95) 100%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: white;
  z-index: 1000;
  backdrop-filter: blur(10px);
}

.spinner {
  width: 60px;
  height: 60px;
  border: 4px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  border-top-color: #1890ff;
  border-right-color: #1890ff;
  animation: spin 1s cubic-bezier(0.68, -0.55, 0.265, 1.55) infinite;
  margin-bottom: 20px;
  box-shadow: 0 0 20px rgba(24, 144, 255, 0.3);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-text {
  font-size: 16px;
  font-weight: 500;
  letter-spacing: 1px;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

/* 响应式设计 */
@media (max-width: 768px) {
  .graph-overlay-panel {
    top: 10px;
    right: 10px;
    left: 10px;
    width: auto;
    height: calc(100% - 20px);
  }

  .legend-panel {
    padding: 10px 12px;
    bottom: 10px;
    right: 10px;
    min-width: 120px;
  }

  .panel-title {
    font-size: 14px;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    font-size: 16px;
  }
}
</style>
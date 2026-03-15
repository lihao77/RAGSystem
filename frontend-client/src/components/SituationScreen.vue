<template>
  <Teleport to="body">
    <div class="situation-screen" @keydown.esc="$emit('close')">
      <!-- 顶部态势信息条 -->
      <SituationBar :mapData="mapData" @close="$emit('close')" />

      <!-- 地图全屏底层 -->
      <div class="situation-map-layer">
        <MapRenderer
          v-if="mapData"
          :mapData="mapData"
          :title="mapData.title || '态势大屏'"
          :situationMode="true"
          @analyze-location="handleAnalyzeLocation"
        />
      </div>

      <!-- 浮动对话面板 -->
      <FloatingChatPanel
        :messages="messages"
        :isStreaming="isStreaming"
        :prefillText="prefillText"
        @send-message="handleSendMessage"
        @close="$emit('close')"
      />
    </div>
  </Teleport>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import MapRenderer from './MapRenderer.vue';
import SituationBar from './SituationBar.vue';
import FloatingChatPanel from './FloatingChatPanel.vue';

const props = defineProps({
  artifactId: { type: String, default: '' },
  mapData: { type: Object, default: () => ({}) },
  messages: { type: Array, default: () => [] },
  isStreaming: { type: Boolean, default: false },
  situationInfo: { type: Object, default: null },
});

const emit = defineEmits(['close', 'send-message']);

const prefillText = ref('');

const handleSendMessage = (text) => {
  emit('send-message', text);
};

const handleAnalyzeLocation = (locationName) => {
  prefillText.value = `请详细分析${locationName}的风险情况并给出应急建议`;
  // 重置 prefill 避免重复触发
  setTimeout(() => { prefillText.value = ''; }, 100);
};

// ESC 键退出
const handleKeydown = (e) => {
  if (e.key === 'Escape') {
    emit('close');
  }
};

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  // 防止背景滚动
  document.body.style.overflow = 'hidden';
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
  document.body.style.overflow = '';
});
</script>

<style scoped>
.situation-screen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 10000;
  background: #0a0a14;
  display: flex;
  flex-direction: column;
}

.situation-map-layer {
  flex: 1;
  position: relative;
  overflow: hidden;
}

/* 在态势大屏模式下，MapRenderer 要占满整个区域，隐藏头部和底部 */
.situation-map-layer :deep(.map-renderer) {
  border: none;
  border-radius: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.situation-map-layer :deep(.map-header) {
  display: none;
}

.situation-map-layer :deep(.map-footer) {
  display: none;
}

.situation-map-layer :deep(.map-body) {
  flex: 1;
}

.situation-map-layer :deep(.map-container) {
  height: 100% !important;
}

.situation-map-layer :deep(.map-legend) {
  bottom: 24px;
  right: 410px; /* 避免被浮动面板遮挡 */
}
</style>

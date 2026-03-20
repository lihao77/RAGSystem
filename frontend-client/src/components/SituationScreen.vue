<template>
  <Teleport to="body">
    <div class="situation-screen" :class="{ 'panel-collapsed': panelCollapsed }" @keydown.esc="$emit('close')">
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
        @collapse-change="panelCollapsed = $event"
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
const panelCollapsed = ref(false);

const handleSendMessage = (text) => {
  emit('send-message', text);
};

const handleAnalyzeLocation = (locationName) => {
  prefillText.value = `请详细分析${locationName}的风险情况并给出应急建议`;
  setTimeout(() => { prefillText.value = ''; }, 100);
};

const handleKeydown = (e) => {
  if (e.key === 'Escape') {
    emit('close');
  }
};

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
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
  background: var(--color-bg-app);
  display: flex;
  flex-direction: column;
}

.situation-map-layer {
  flex: 1;
  position: relative;
  z-index: 1;
  overflow: hidden;
}

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
  right: 410px;
  transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.panel-collapsed .situation-map-layer :deep(.map-legend) {
  right: 48px;
}
</style>

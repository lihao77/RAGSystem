<template>
  <Teleport to="body">
    <div class="artifact-map-screen" @keydown.esc="emit('close')">
      <header class="artifact-map-screen__bar">
        <div class="flex min-w-0 items-center gap-2">
          <Map aria-hidden="true" />
          <h1 class="truncate text-sm font-semibold">空间数据工作台</h1>
          <Badge variant="secondary">{{ layers.length }} 个图层</Badge>
        </div>
        <TooltipProvider :delay-duration="250">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon" aria-label="关闭地图工作台" @click="emit('close')">
                <X data-icon="inline-start" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>关闭地图工作台</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>

      <main class="artifact-map-screen__map" :class="{ 'artifact-map-screen__map--chat-collapsed': panelCollapsed }">
        <MapWorkspace
          ref="workspaceRef"
          :layers="layers"
          class="artifact-map-screen__workspace"
          @ready="emit('ready', $event)"
          @update:layers="emit('update:layers', $event)"
        />
      </main>

      <FloatingChatPanel
        v-model:collapsed="panelCollapsed"
        :messages="messages"
        :is-streaming="isStreaming"
        :prefill-text="prefillText"
        @send-message="emit('send-message', $event)"
        @close="emit('close')"
      />
    </div>
  </Teleport>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Map, X } from 'lucide-vue-next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import FloatingChatPanel from '../FloatingChatPanel.vue';
import MapWorkspace from './MapWorkspace.vue';

defineProps({
  layers: { type: Array, default: () => [] },
  messages: { type: Array, default: () => [] },
  isStreaming: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'ready', 'send-message', 'update:layers']);
const workspaceRef = ref(null);
const panelCollapsed = ref(typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches);
const prefillText = ref('');

function handleKeydown(event) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  if (window.innerWidth <= 767) panelCollapsed.value = true;
  document.addEventListener('keydown', handleKeydown);
  document.body.style.overflow = 'hidden';
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
  document.body.style.overflow = '';
});

defineExpose({
  fitLayer: (...args) => workspaceRef.value?.fitLayer?.(...args),
  fitAllLayers: (...args) => workspaceRef.value?.fitAllLayers?.(...args),
  getView: (...args) => workspaceRef.value?.getView?.(...args),
  setView: (...args) => workspaceRef.value?.setView?.(...args),
  getMap: (...args) => workspaceRef.value?.getMap?.(...args),
});
</script>

<style scoped>
.artifact-map-screen {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-app);
}

.artifact-map-screen__bar {
  display: flex;
  min-height: 48px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-primary);
  padding: 8px 16px;
}

.artifact-map-screen__map {
  position: relative;
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
}

.artifact-map-screen__workspace {
  height: 100%;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.artifact-map-screen__map :deep(section[aria-label="地理空间地图工作台"]) {
  height: 100%;
  min-height: 0;
}

@media (min-width: 768px) {
  .artifact-map-screen__map :deep(aside) {
    margin-right: 380px;
  }

  .artifact-map-screen__map--chat-collapsed :deep(aside) {
    margin-right: 0;
  }
}
</style>

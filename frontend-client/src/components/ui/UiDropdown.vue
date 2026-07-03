<template>
  <span ref="triggerRef" class="ui-dropdown-trigger">
    <slot name="trigger" :open="open" :toggle="toggle" />
    <Teleport to="body">
      <div v-if="open" ref="panelRef" class="ui-dropdown" :style="panelStyle" @click="onPanelClick">
        <slot name="content" :close="close" />
      </div>
    </Teleport>
  </span>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { usePointerDownOutside } from '../../composables/usePointerDownOutside';

const props = defineProps({
  placement: { type: String, default: 'bottom-start' },
  closeOnClick: { type: Boolean, default: true },
});

const triggerRef = ref(null);
const panelRef = ref(null);
const open = ref(false);
const panelStyle = ref({});

function compute() {
  const el = triggerRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  panelStyle.value = {
    left: `${r.left}px`,
    top: `${r.bottom + 4}px`,
    minWidth: `${r.width}px`,
  };
}

function toggle() {
  if (open.value) close();
  else {
    open.value = true;
    nextTick(compute);
  }
}

function close() {
  open.value = false;
}

function onPanelClick() {
  if (props.closeOnClick) close();
}

usePointerDownOutside({
  inside: [triggerRef, panelRef],
  enabled: () => open.value,
  onOutside: close,
});

defineExpose({ open, toggle, close });
</script>

<style scoped>
.ui-dropdown-trigger {
  display: inline-flex;
}

.ui-dropdown {
  position: fixed;
  z-index: var(--z-dropdown);
  padding: var(--spacing-xs);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  min-width: 160px;
}
</style>

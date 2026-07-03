<template>
  <span ref="triggerRef" class="ui-tooltip-trigger" @mouseenter="show" @mouseleave="hide" @focusin="show" @focusout="hide">
    <slot />
    <Teleport to="body">
      <Transition name="tooltip-fade">
        <div v-if="open" class="ui-tooltip" :style="popperStyle" role="tooltip">
          {{ content }}
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<script setup>
import { ref, nextTick } from 'vue';

const props = defineProps({
  content: { type: String, default: '' },
  placement: { type: String, default: 'top' },
  delay: { type: Number, default: 100 },
});

const triggerRef = ref(null);
const open = ref(false);
const popperStyle = ref({});
let timer = null;

function compute() {
  const el = triggerRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const top = props.placement === 'top' ? r.top - 6 : r.bottom + 6;
  popperStyle.value = {
    left: `${r.left + r.width / 2}px`,
    top: `${top}px`,
    transform: props.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
  };
}

function show() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    open.value = true;
    nextTick(compute);
  }, props.delay);
}

function hide() {
  clearTimeout(timer);
  open.value = false;
}
</script>

<style scoped>
.ui-tooltip-trigger {
  display: inline-flex;
}

.ui-tooltip {
  position: fixed;
  z-index: var(--z-dialog);
  padding: 4px var(--spacing-xs);
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--shadow-md);
}

.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity var(--transition-fast);
}

.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
}
</style>

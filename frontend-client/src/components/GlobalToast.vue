<template>
  <Teleport to="body">
    <Transition name="toast">
      <div v-if="state.visible" class="app-toast" :class="state.type">
        <span>{{ state.message }}</span>
        <UiButton v-if="state.action" variant="link" @click="runAction">
          {{ state.actionLabel }}
        </UiButton>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { useToast } from '../composables/useToast';
import { UiButton } from './ui';

const { state, hide } = useToast();

function runAction() {
  const action = state.action;
  hide();
  action?.();
}
</script>

<style scoped>
.app-toast {
  position: fixed;
  top: var(--spacing-lg);
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  max-width: min(90vw, 420px);
  border-radius: var(--radius-lg);
  border: var(--glass-border-width) var(--glass-border-style) var(--glass-border-color);
  border-left-width: 3px;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
}

.app-toast.success {
  border-left-color: var(--color-success);
}

.app-toast.error {
  border-left-color: var(--color-error);
}

.app-toast.warning {
  border-left-color: var(--color-warning);
}

.app-toast span {
  flex: 1;
}

.app-toast__action {
  padding: 6px 12px;
  border-radius: var(--control-radius);
  border: none;
  background: transparent;
  color: var(--color-brand-accent);
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.app-toast__action:hover {
  background: var(--color-hover-overlay-md);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s, transform 0.4s;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px) scale(0.9);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px) scale(0.9);
}
</style>

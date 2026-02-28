<template>
  <Transition name="toast">
    <div v-if="visible" class="app-toast" :class="type">
      <span>{{ message }}</span>
      <button v-if="action" class="app-toast__action" @click="action">{{ actionLabel }}</button>
    </div>
  </Transition>
</template>

<script setup>
import { ref } from 'vue';

const visible = ref(false);
const message = ref('');
const type = ref('error');
const action = ref(null);
const actionLabel = ref('重试');

let timer = null;

function show(msg, typeOrAction = 'error', label = '重试') {
  if (timer) clearTimeout(timer);
  message.value = msg;
  action.value = typeof typeOrAction === 'function' ? typeOrAction : null;
  type.value = typeof typeOrAction === 'string' ? typeOrAction : 'error';
  actionLabel.value = label;
  visible.value = true;
  timer = setTimeout(() => { visible.value = false; }, 3000);
}

defineExpose({ show });
</script>

<style scoped>
.app-toast {
  position: fixed;
  top: var(--spacing-lg);
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  max-width: min(90vw, 420px);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-glass-border);
  border-left-width: 3px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.app-toast.success { border-left-color: var(--color-success); background: var(--color-success-bg); }
.app-toast.error   { border-left-color: var(--color-error);   background: var(--color-error-bg); }
.app-toast.warning { border-left-color: var(--color-warning); background: var(--color-warning-bg); }

.app-toast span { flex: 1; }

.app-toast__action {
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.toast-enter-active, .toast-leave-active { transition: opacity var(--transition-normal), transform var(--transition-normal); }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
.toast-leave-to   { opacity: 0; transform: translateX(-50%) translateY(-8px); }
</style>

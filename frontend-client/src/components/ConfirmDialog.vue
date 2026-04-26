<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible" class="dialog-overlay">
        <div ref="dialogRef" class="dialog-container">
          <div class="dialog-header">
            <h3 class="dialog-title">{{ title }}</h3>
          </div>
          <div class="dialog-body">
            <p class="dialog-message">{{ message }}</p>
          </div>
          <div class="dialog-footer">
            <button class="dialog-btn dialog-btn-cancel" @click="handleCancel">
              {{ cancelText }}
            </button>
            <button class="dialog-btn dialog-btn-confirm" @click="handleConfirm">
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue';
import { usePointerDownOutside } from '../composables/usePointerDownOutside';

const props = defineProps({
  title: {
    type: String,
    default: '确认操作'
  },
  message: {
    type: String,
    required: true
  },
  confirmText: {
    type: String,
    default: '确定'
  },
  cancelText: {
    type: String,
    default: '取消'
  }
});

const emit = defineEmits(['confirm', 'cancel', 'close']);

const visible = ref(false);
const dialogRef = ref(null);

const show = () => {
  visible.value = true;
};

const hide = () => {
  visible.value = false;
};

const handleConfirm = () => {
  emit('confirm');
  hide();
};

const handleCancel = () => {
  emit('cancel');
  hide();
};

usePointerDownOutside({
  inside: [dialogRef],
  enabled: () => visible.value,
  onOutside: handleCancel,
});

defineExpose({
  show,
  hide
});
</script>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-toast);
  padding: var(--spacing-md);
}

.dialog-container {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-xl);
  max-width: 420px;
  width: 100%;
  overflow: hidden;
}

.dialog-header {
  padding: var(--spacing-lg) var(--spacing-lg) var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}

.dialog-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.dialog-body {
  padding: var(--spacing-lg);
}

.dialog-message {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.dialog-footer {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  gap: var(--spacing-sm);
  justify-content: flex-end;
}

.dialog-btn {
  padding: 12px 24px;
  border-radius: var(--radius-lg);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  border: none;
  outline: none;
  box-shadow: var(--shadow-sm);
}

.dialog-btn-cancel {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.dialog-btn-cancel:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.dialog-btn-confirm {
  background: var(--color-error);
  color: var(--color-on-color);
  box-shadow: 0 2px 8px rgba(var(--color-error-rgb), 0.3);
}

.dialog-btn-confirm:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(var(--color-error-rgb), 0.4);
}

.dialog-btn:active {
  transform: scale(0.98) translateY(0);
}

/* 动画 */
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.3s ease;
}

.dialog-fade-enter-active .dialog-container,
.dialog-fade-leave-active .dialog-container {
  transition: transform 0.4s ease, opacity 0.3s ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-enter-from .dialog-container,
.dialog-fade-leave-to .dialog-container {
  transform: scale(0.9) translateY(20px);
  opacity: 0;
}

/* 移动端适配 */
@media (max-width: 767px) {
  .dialog-container {
    max-width: calc(100vw - 32px);
  }

  .dialog-header {
    padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm);
  }

  .dialog-body {
    padding: var(--spacing-md);
  }

  .dialog-footer {
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
    flex-direction: column-reverse;
  }

  .dialog-btn {
    width: 100%;
    padding: 12px 20px;
  }
}
</style>

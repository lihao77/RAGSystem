<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="state.visible" class="dialog-overlay" @click.self="cancel">
        <div ref="dialogRef" class="dialog-container" role="dialog" aria-modal="true" :aria-label="state.title">
          <div class="dialog-header">
            <h3 class="dialog-title">{{ state.title }}</h3>
          </div>
          <div class="dialog-body">
            <p class="dialog-message">{{ state.message }}</p>
          </div>
          <div class="dialog-footer">
            <UiButton class="dialog-btn" variant="ghost" @click="cancel">{{ state.cancelText }}</UiButton>
            <UiButton
              class="dialog-btn"
              :variant="state.danger ? 'danger' : 'primary'"
              @click="accept"
            >{{ state.confirmText }}</UiButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 全局确认弹窗宿主。读 useConfirm 单例状态渲染,挂在 App 根(唯一实例)。
 * 样式移植自旧 ConfirmDialog.vue(已删),补 danger 语义与 Esc/点外关闭。
 */
import { ref, watch, onBeforeUnmount } from 'vue';
import { useConfirm } from '../composables/useConfirm';
import { usePointerDownOutside } from '../composables/usePointerDownOutside';
import { UiButton } from './ui';

const { state, accept, cancel } = useConfirm();

const dialogRef = ref(null);

usePointerDownOutside({
  inside: [dialogRef],
  enabled: () => state.visible,
  onOutside: cancel,
});

function onKeydown(e) {
  if (e.key === 'Escape' && state.visible) cancel();
}

watch(
  () => state.visible,
  (visible) => {
    if (visible) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
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
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-toast);
  padding: var(--spacing-md);
}

.dialog-container {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
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
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--control-radius);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-normal);
  border: none;
  outline: none;
  box-shadow: none;
}

.dialog-btn-cancel {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.dialog-btn-cancel:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.dialog-btn-confirm {
  background: var(--color-brand-accent);
  color: var(--color-on-accent);
  box-shadow: none;
}

.dialog-btn-confirm:hover {
  background: var(--color-brand-accent-light);
  box-shadow: none;
}

.dialog-btn-confirm--danger {
  background: var(--color-error);
  box-shadow: none;
}

.dialog-btn-confirm--danger:hover {
  filter: brightness(1.1);
  box-shadow: none;
}

.dialog-btn:active {
  transform: scale(0.98);
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

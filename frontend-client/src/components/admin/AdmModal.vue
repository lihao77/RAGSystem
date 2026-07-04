<template>
  <Teleport to="body">
    <Transition name="adm-modal">
      <div v-if="open" class="adm-modal-overlay" @click.self="handleOverlay">
        <div
          ref="panelRef"
          class="adm-modal adm-modal-panel"
          :style="{ '--adm-modal-width': width }"
          role="dialog"
          aria-modal="true"
          :aria-label="title || undefined"
        >
          <header v-if="title || $slots.header" class="adm-modal-header">
            <slot name="header">
              <h3 class="adm-modal__title">{{ title }}</h3>
            </slot>
            <button
              v-if="closable"
              type="button"
              class="adm-modal__close"
              aria-label="关闭"
              @click="requestClose"
            >
              <IconClose :size="16" />
            </button>
          </header>

          <div class="adm-modal-body">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="adm-modal-footer">
            <slot name="footer" :close="requestClose" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 管理端通用模态。收敛各页自造的 modal-overlay + modal-shell + usePointerDownOutside 套路。
 * 内容样式复用全局 .adm-modal / .adm-modal-header / -body / -footer(admin-console.css),
 * 这里只补 overlay 定位、宽度变量、进出场动画与点外/Esc 关闭。
 */
import { ref, watch, onBeforeUnmount } from 'vue';
import { usePointerDownOutside } from '../../composables/usePointerDownOutside';
import IconClose from '../icons/IconClose.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: String, default: '480px' },
  closable: { type: Boolean, default: true },
  closeOnOverlay: { type: Boolean, default: true },
});

const emit = defineEmits(['update:open', 'close']);

const panelRef = ref(null);

function requestClose() {
  emit('update:open', false);
  emit('close');
}

function handleOverlay() {
  if (props.closeOnOverlay && props.closable) requestClose();
}

usePointerDownOutside({
  inside: [panelRef],
  enabled: () => props.open,
  onOutside: handleOverlay,
});

function onKeydown(e) {
  if (e.key === 'Escape' && props.open && props.closable) requestClose();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKeydown);
    } else {
      document.removeEventListener('keydown', onKeydown);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.adm-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 1000);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-md);
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.adm-modal-panel {
  width: min(var(--adm-modal-width, 480px), 100%);
  max-height: min(88vh, 880px);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  overflow: hidden;
}

.adm-modal__title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-lg);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
}

.adm-modal__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--control-radius);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.adm-modal__close:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.adm-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.adm-modal-enter-active,
.adm-modal-leave-active {
  transition: opacity 0.2s ease;
}

.adm-modal-enter-active .adm-modal-panel,
.adm-modal-leave-active .adm-modal-panel {
  transition: transform 0.24s var(--ease-out-expo), opacity 0.2s ease;
}

.adm-modal-enter-from,
.adm-modal-leave-to {
  opacity: 0;
}

.adm-modal-enter-from .adm-modal-panel,
.adm-modal-leave-to .adm-modal-panel {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}

@media (max-width: 600px) {
  .adm-modal-overlay {
    padding: 0;
    align-items: flex-end;
  }

  .adm-modal-panel {
    width: 100%;
    max-height: 92vh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }
}
</style>

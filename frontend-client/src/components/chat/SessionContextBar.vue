<template>
  <div class="session-context-bar top-controls-bar glass-card" :class="{ scrolled }">
    <div class="left-controls glass-card">
      <button class="hamburger-menu-btn" @click="emit('openMobileSidebar')" title="Open menu">
        <IconMenu :size="20" />
      </button>

      <LLMSelector
        ref="llmSelectorRef"
        :model-value="selectedLLM"
        @update:model-value="emit('update:selectedLLM', $event)"
      />
    </div>

    <div class="right-controls glass-card">
      <PermissionModeSelector />
      <button
        @click="emit('exportSession')"
        class="session-export-btn version-btn top-action-btn"
        :disabled="!currentSessionId || isExportingSession"
        :title="currentSessionId ? '导出当前会话' : '当前无会话可导出'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3v12"></path>
          <path d="m7 10 5 5 5-5"></path>
          <path d="M5 21h14"></path>
        </svg>
      </button>
      <button @click="emit('toggleTheme')" class="theme-btn btn" :title="isDark ? '切换到亮色模式' : '切换到暗色模式'">
        <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import LLMSelector from '../LLMSelector.vue';
import PermissionModeSelector from '../PermissionModeSelector.vue';
import { IconMenu } from '../icons';

const props = defineProps({
  selectedLLM: { type: String, default: '' },
  isDark: { type: Boolean, default: true },
  currentSessionId: { type: String, default: '' },
  isExportingSession: { type: Boolean, default: false },
  scrolled: { type: Boolean, default: false },
});

const emit = defineEmits([
  'update:selectedLLM',
  'toggleTheme',
  'openMobileSidebar',
  'exportSession',
]);

const llmSelectorRef = ref(null);

function getSelection() {
  return llmSelectorRef.value?.getSelection?.() || props.selectedLLM || '';
}

defineExpose({ getSelection });
</script>

<style scoped>
.session-context-bar {
  z-index: var(--z-sticky);
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr) minmax(0, auto);
  align-items: center;
  gap: 10px;
  pointer-events: none;
  padding: var(--top-bar-padding-y) var(--top-bar-padding-x);
  position: relative;
  background: none;
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: none;
  letter-spacing: 0;
}

.session-context-bar::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--top-bar-divider-left);
  right: var(--top-bar-divider-right);
  height: 1px;
  background: var(--color-glass-border);
  opacity: 0;
  transition: opacity 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.session-context-bar > * {
  pointer-events: auto;
}

.left-controls,
.right-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px;
  border-radius: 28px;
  background-color: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-glass-border);
  box-shadow: var(--shadow-md);
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.left-controls:hover,
.right-controls:hover {
  box-shadow: var(--shadow-lg);
}

.right-controls {
  grid-column: 3;
  justify-self: end;
}

.left-controls .llm-selector {
  max-width: 220px;
  flex-shrink: 1;
  min-width: 0;
}

.session-context-strip {
  min-width: 0;
  justify-self: center;
  position: relative;
  max-width: min(560px, 100%);
}

.session-context-summary {
  min-width: 0;
  max-width: 100%;
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--color-glass-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.46);
  color: var(--color-text-secondary);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  font: inherit;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.session-context-summary:hover,
.session-context-summary.is-expanded {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.62);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-md);
}

.context-chip {
  min-width: 0;
  max-width: 160px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  color: var(--color-text-secondary);
}

.context-chip__label {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  color: var(--color-text-muted);
}

.context-chip__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1;
  font-weight: 650;
}

.context-chip--status {
  --status-tone: var(--color-text-muted);
  --status-tone-rgb: var(--color-text-muted-rgb, 142, 142, 147);
  color: var(--status-tone);
  border-color: rgba(var(--status-tone-rgb), 0.24);
  background: rgba(var(--status-tone-rgb), 0.08);
}

.context-chip--status.tone-running {
  --status-tone: var(--color-brand-accent);
  --status-tone-rgb: var(--color-brand-accent-rgb);
}

.context-chip--status.tone-warning {
  --status-tone: var(--color-warning);
  --status-tone-rgb: var(--color-warning-rgb);
}

.context-chip--status.tone-error {
  --status-tone: var(--color-error);
  --status-tone-rgb: var(--color-error-rgb);
}

.context-chip--status.tone-success {
  --status-tone: var(--color-success);
  --status-tone-rgb: var(--color-success-rgb);
}

.context-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  flex-shrink: 0;
}

.tone-running .context-status-dot {
  animation: contextStatusPulse 1.6s ease-in-out infinite;
}

.context-chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast), color var(--transition-fast);
}

.context-chevron.open {
  transform: rotate(180deg);
  color: var(--color-text-primary);
}

.session-meta-panel {
  position: absolute;
  top: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 120;
  width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
}

.session-meta-section {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.session-meta-section + .session-meta-section {
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.session-meta-section-title {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: 700;
}

.session-meta-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.session-meta-label {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.session-meta-value {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.session-meta-value--path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.theme-btn,
.version-btn {
  width: 44px;
  min-width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 22px;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  box-shadow: none;
}

.theme-btn:hover,
.session-export-btn:hover:not(:disabled) {
  transform: scale(1.1);
}

.theme-btn:active,
.session-export-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.session-export-btn {
  gap: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-weight: 500;
}

.session-export-btn:hover:not(:disabled) {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-sm);
}

.session-export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.top-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.top-action-btn svg {
  flex-shrink: 0;
}

.hamburger-menu-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  display: var(--hamburger-display);
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}

.hamburger-menu-btn:hover {
  background-color: var(--color-interactive-hover);
  box-shadow: var(--shadow-md);
  transform: scale(1.1);
}

.hamburger-menu-btn:active {
  transform: scale(0.95);
  box-shadow: var(--shadow-sm);
}

@keyframes contextStatusPulse {
  0%, 100% {
    opacity: 0.45;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

@media (min-width: 1025px) {
  .session-context-bar::after {
    background: linear-gradient(90deg,
        transparent,
        var(--color-border) 10%,
        var(--color-border) 90%,
        transparent);
    opacity: 1;
  }
}

@media (max-width: 1024px) and (min-width: 768px) {
  .session-context-bar.scrolled::after {
    opacity: 1;
  }

  .session-context-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
  }

  .session-context-strip {
    max-width: min(360px, 100%);
  }

  .context-chip {
    max-width: 120px;
  }
}

@media (max-width: 900px) {
  .context-chip--team,
  .context-chip--agent {
    display: none;
  }
}

@media (max-width: 767px) {
  .session-context-bar.scrolled::after {
    opacity: 1;
  }

  .session-context-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .left-controls,
  .right-controls {
    gap: 4px;
    padding: 2px;
  }

  .session-context-strip {
    display: none;
  }

  .theme-btn,
  .version-btn,
  .top-action-btn {
    width: 44px;
    min-width: 44px;
    height: 44px;
    padding: 0;
    justify-content: center;
    gap: 0;
  }

  .top-action-btn svg {
    width: 20px;
    height: 20px;
  }
}

@media (max-width: 480px) {
  .session-context-bar.scrolled::after {
    opacity: 1;
    left: var(--top-bar-divider-left);
    right: var(--top-bar-divider-right);
  }
}

@media (prefers-reduced-motion: reduce) {
  .context-status-dot,
  .tone-running .context-status-dot {
    animation: none;
  }

  .session-context-bar::after,
  .left-controls,
  .right-controls,
  .session-context-summary,
  .context-chevron,
  .theme-btn,
  .version-btn,
  .hamburger-menu-btn {
    transition-duration: 1ms;
  }
}
</style>

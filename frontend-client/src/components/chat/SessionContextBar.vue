<template>
  <div class="session-context-bar top-controls-bar" :class="{ scrolled }">
    <div class="left-controls glass-card">
      <Button
        variant="ghost"
        size="icon"
        class="sidebar-menu-trigger rounded-full"
        aria-label="打开菜单"
        title="打开菜单"
        @click="emit('openMobileSidebar')"
      >
        <IconMenu />
      </Button>

      <LLMSelector ref="llmSelectorRef" />
    </div>

    <div v-if="!isCompactToolbar" class="right-controls desktop-actions glass-card">
      <Button variant="ghost" size="sm" :disabled="!currentSessionId" title="查看最近一次 Agent 消息的文件变更" @click="emit('openFileChanges')">
        <FileText data-icon="inline-start" />
        本轮变更
      </Button>
      <PermissionModeSelector :session-id="currentSessionId" />
      <Button
        variant="ghost"
        size="icon"
        class="rounded-full"
        aria-label="导出当前会话"
        :disabled="!currentSessionId || isExportingSession"
        :title="currentSessionId ? '导出当前会话' : '当前无会话可导出'"
        @click="emit('exportSession')"
      >
        <Download />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="rounded-full"
        aria-label="切换主题"
        :title="themeStore.isDark ? '切换到亮色模式' : '切换到暗色模式'"
        @click="themeStore.toggle()"
      >
        <Sun v-if="themeStore.isDark" />
        <Moon v-else />
      </Button>
    </div>

    <div v-else class="right-controls mobile-actions glass-card">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="rounded-full" aria-label="更多会话操作" title="更多会话操作">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem :disabled="!currentSessionId" @select="emit('openFileChanges')">
              <FileText />
              本轮变更
            </DropdownMenuItem>
            <PermissionModeSelector presentation="submenu" :session-id="currentSessionId" />
            <DropdownMenuItem
              :disabled="!currentSessionId || isExportingSession"
              @select="emit('exportSession')"
            >
              <Download />
              导出会话
            </DropdownMenuItem>
            <DropdownMenuItem @select="themeStore.toggle()">
              <Sun v-if="themeStore.isDark" />
              <Moon v-else />
              {{ themeStore.isDark ? '切换到亮色模式' : '切换到暗色模式' }}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { Download, Ellipsis, FileText, Moon, Sun } from 'lucide-vue-next';
import LLMSelector from '../LLMSelector.vue';
import PermissionModeSelector from '../PermissionModeSelector.vue';
import { IconMenu } from '../icons';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useThemeStore } from '../../stores/theme.js';

const themeStore = useThemeStore();
const isCompactToolbar = useMediaQuery('(max-width: 900px)');

defineProps({
  currentSessionId: { type: String, default: '' },
  isExportingSession: { type: Boolean, default: false },
  scrolled: { type: Boolean, default: false },
});

const emit = defineEmits([
  'openMobileSidebar',
  'exportSession',
  'openFileChanges',
]);

const llmSelectorRef = ref(null);

function getSelection() {
  return llmSelectorRef.value?.getSelection?.() || '';
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
  /* 纯布局容器:不做模糊,玻璃感由 left/right 胶囊各自承担,避免双层 backdrop-filter 穿透糊边 */
  background: none;
  backdrop-filter: none;
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
  transition: opacity 0.3s var(--ease-default);
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
  transition: all 0.3s var(--ease-default);
}

.left-controls:hover,
.right-controls:hover {
  box-shadow: var(--shadow-lg);
}

.right-controls {
  grid-column: 3;
  justify-self: end;
}

.sidebar-menu-trigger,
.mobile-actions {
  display: none;
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
  background: var(--surface-shell);
  color: var(--color-text-secondary);
}

.context-chip__label {
  flex-shrink: 0;
  /* badge 小字无更小 token，就近取 xs */
  font-size: var(--font-size-xs);
  line-height: 1;
  font-weight: 700;
  color: var(--color-text-muted);
}

.context-chip__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
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
  width: var(--icon-button-size-md);
  min-width: var(--icon-button-size-md);
  height: var(--control-height-md);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-full);
  transition: all 0.3s var(--ease-default);
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
  width: var(--icon-button-size-md);
  height: var(--control-height-md);
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  display: var(--hamburger-display);
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s var(--ease-default);
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
  .session-context-bar {
    position: relative;
    top: auto;
    left: auto;
    right: auto;
    flex: 0 0 auto;
  }

  .sidebar-menu-trigger,
  .mobile-actions {
    display: inline-flex;
  }

  .desktop-actions {
    display: none;
  }

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
    position: relative;
    top: auto;
    left: auto;
    right: auto;
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

<template>
  <Teleport to="body">
    <Transition name="hk-fade">
      <div v-if="visible" class="hk-overlay" @click.self="close">
        <div class="hk-panel" role="dialog" aria-modal="true" aria-label="快捷键帮助">
          <div class="hk-header">
            <span class="hk-title">键盘快捷键</span>
            <button class="hk-close" @click="close" aria-label="关闭">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div class="hk-body">
            <div v-for="[group, items] in groups" :key="group" class="hk-group">
              <div class="hk-group-title">{{ group }}</div>
              <div v-for="b in items" :key="b.id" class="hk-row">
                <span class="hk-desc">{{ b.description }}</span>
                <span class="hk-keys">
                  <kbd v-for="(tok, i) in comboTokens(b.combo)" :key="i" class="hk-kbd">{{ tok }}</kbd>
                </span>
              </div>
            </div>
            <div class="hk-footer">
              <span>更多操作用</span>
              <kbd class="hk-kbd">⌘</kbd><kbd class="hk-kbd">K</kbd>
              <span>命令面板搜索</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue';
import { useGlobalHotkeys } from '../composables/useGlobalHotkeys.js';

const { helpVisible, bindings } = useGlobalHotkeys();
const visible = helpVisible;
const close = () => { helpVisible.value = false; };

const GROUP_ORDER = ['操作', '导航', '会话', '帮助'];
const groups = computed(() => {
  const buckets = {};
  for (const b of bindings.value) {
    const g = b.group || '其它';
    (buckets[g] ||= []).push(b);
  }
  const ordered = Object.keys(buckets).sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return ordered.map((g) => [g, buckets[g]]);
});

const MOD_SYMBOLS = { alt: '⌥', ctrl: '⌃', shift: '⇧', meta: '⌘', mod: '⌘' };
const KEY_SYMBOLS = {
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  enter: '↵', escape: 'Esc', space: 'Space', backspace: '⌫', tab: 'Tab',
};
function comboTokens(combo) {
  return combo
    .split(' ')
    .flatMap((seg) => seg.split('+'))
    .map((tok) => {
      if (MOD_SYMBOLS[tok]) return MOD_SYMBOLS[tok];
      if (KEY_SYMBOLS[tok]) return KEY_SYMBOLS[tok];
      if (tok.length === 1) return tok.toUpperCase();
      return tok;
    });
}
</script>

<style scoped>
.hk-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh var(--spacing-md) 0;
  z-index: var(--z-dialog);
}

.hk-panel {
  width: 100%;
  max-width: 520px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}

.hk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}

.hk-title {
  font-size: var(--font-size-sm);
  font-weight: 590;
  color: var(--color-text-primary);
  letter-spacing: 0.01em;
}

.hk-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.hk-close:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.hk-body {
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
  max-height: 60vh;
  overflow-y: auto;
}

.hk-group + .hk-group {
  margin-top: var(--spacing-sm);
}

.hk-group-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  padding: var(--spacing-xs) var(--spacing-xs) 4px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.hk-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px var(--spacing-xs);
  border-radius: var(--control-radius);
}

.hk-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.hk-keys {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hk-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  font-size: var(--font-size-xs);
  font-family: var(--font-sans);
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  line-height: 1;
}

.hk-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-xs) 0;
  border-top: 1px solid var(--color-border);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.hk-fade-enter-active,
.hk-fade-leave-active {
  transition: opacity var(--transition-fast);
}
.hk-fade-enter-from,
.hk-fade-leave-to {
  opacity: 0;
}
</style>

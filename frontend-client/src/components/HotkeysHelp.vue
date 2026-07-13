<template>
  <Dialog :open="visible" @update:open="(v) => { if (!v) close() }">
    <DialogContent class="max-w-[520px] gap-0 p-0 overflow-hidden">
      <DialogHeader class="px-4 py-3 space-y-0 border-b border-border">
        <DialogTitle>键盘快捷键</DialogTitle>
      </DialogHeader>
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
        <div v-for="g in contextGroups" :key="g.title" class="hk-group">
          <div class="hk-group-title">{{ g.title }}</div>
          <div v-for="item in g.items" :key="item.desc" class="hk-row">
            <span class="hk-desc">{{ item.desc }}</span>
            <span class="hk-keys">
              <kbd v-for="(tok, i) in comboTokens(item.combo)" :key="i" class="hk-kbd">{{ tok }}</kbd>
            </span>
          </div>
        </div>
        <div class="hk-footer">
          <span>更多操作用</span>
          <kbd class="hk-kbd">⌘</kbd><kbd class="hk-kbd">K</kbd>
          <span>命令面板搜索</span>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed } from 'vue';
import { useGlobalHotkeys } from '../composables/useGlobalHotkeys.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

const { helpVisible, bindings } = useGlobalHotkeys();
const visible = helpVisible;
const close = () => { helpVisible.value = false; };

const GROUP_ORDER = ['操作', '导航', '会话', '帮助'];

// 上下文快捷键：仅在对应面板生效（由组件自身 addEventListener 处理，
// 不进全局监听，仅在此展示，保证帮助面板与实际可用键一致）
const contextGroups = [
  {
    title: '上下文（仅在对应面板生效）',
    items: [
      { combo: 'escape', desc: '图片预览：关闭' },
      { combo: 'arrowleft', desc: '图片预览：上一张' },
      { combo: 'arrowright', desc: '图片预览：下一张' },
    ],
  },
];
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
</style>

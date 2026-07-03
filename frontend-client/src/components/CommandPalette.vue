<template>
  <Teleport to="body">
    <Transition name="cmd-fade">
      <div v-if="visible" class="cmd-overlay" @click.self="close">
        <div class="cmd-panel" role="dialog" aria-modal="true" aria-label="命令面板">
          <div class="cmd-input-wrap">
            <input
              ref="inputRef"
              v-model="query"
              class="cmd-input"
              placeholder="输入命令或搜索…"
              autocomplete="off"
              spellcheck="false"
              @keydown.down.prevent="move(1)"
              @keydown.up.prevent="move(-1)"
              @keydown.enter.prevent="runActive"
              @keydown.esc.prevent="close"
            />
          </div>
          <ul v-if="filtered.length" class="cmd-list">
            <li
              v-for="(cmd, i) in filtered"
              :key="cmd.id"
              class="cmd-item"
              :class="{ active: i === activeIndex }"
              @mousemove="activeIndex = i"
              @click="runActive"
            >
              <span class="cmd-item-title">{{ cmd.title }}</span>
              <span v-if="cmd.subtitle" class="cmd-item-sub">{{ cmd.subtitle }}</span>
              <span v-if="cmd.section" class="cmd-item-section">{{ cmd.section }}</span>
            </li>
          </ul>
          <div v-else class="cmd-empty">无匹配命令</div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { useCommandPalette } from '../composables/useCommandPalette.js';

const { visible, query, activeIndex, filtered, close, move, runActive } = useCommandPalette();
const inputRef = ref(null);

watch(visible, (v) => {
  if (v) {
    nextTick(() => inputRef.value?.focus());
  } else {
    query.value = '';
    activeIndex.value = 0;
  }
});
</script>

<style scoped>
.cmd-overlay {
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

.cmd-panel {
  width: 100%;
  max-width: 560px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}

.cmd-input-wrap {
  border-bottom: 1px solid var(--color-border);
  padding: var(--spacing-sm) var(--spacing-md);
}

.cmd-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-family: var(--font-sans);
  padding: var(--spacing-xs) 0;
}

.cmd-input::placeholder {
  color: var(--color-text-muted);
}

.cmd-list {
  list-style: none;
  margin: 0;
  padding: var(--spacing-xs);
  max-height: 360px;
  overflow-y: auto;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--control-radius);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.cmd-item.active {
  background: var(--color-active-bg);
}

.cmd-item-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.cmd-item-sub {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-item-section {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  padding: 2px var(--spacing-xs);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.cmd-empty {
  padding: var(--spacing-lg);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.cmd-fade-enter-active,
.cmd-fade-leave-active {
  transition: opacity var(--transition-fast);
}

.cmd-fade-enter-from,
.cmd-fade-leave-to {
  opacity: 0;
}
</style>

<template>
  <section class="artifact-panel">
    <Transition
      :css="false"
      @before-enter="onBeforeEnter"
      @enter="onEnter"
      @after-enter="onAfterEnter"
      @before-leave="onBeforeLeave"
      @leave="onLeave"
      @after-leave="onAfterLeave"
    >
      <div v-if="artifacts.length" class="artifact-reveal-inner">
        <div class="artifact-panel-header">
      <div class="artifact-panel-title">
        <span class="artifact-panel-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M4 5.5C4 4.7 4.7 4 5.5 4h9c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5v-9Z" />
            <path d="M7 13V9" />
            <path d="M10 13V7" />
            <path d="M13 13v-3" />
          </svg>
        </span>
        <span>产物</span>
      </div>
      <span class="artifact-count">{{ artifacts.length }}</span>
        </div>
        <div class="artifact-list">
      <button
        v-for="artifact in artifacts"
        :key="artifact.artifactId"
        type="button"
        class="artifact-item"
        :title="`定位 ${artifact.artifactId}`"
        @click="emit('select', artifact)"
      >
        <span class="artifact-item-index">{{ artifact.index + 1 }}</span>
        <span class="artifact-item-main">
          <span class="artifact-item-title">{{ artifact.label }}</span>
          <span class="artifact-item-id">{{ artifact.artifactId }}</span>
        </span>
        <span class="artifact-item-action" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M7 4.5h8.5V13" />
            <path d="M15.5 4.5 5 15" />
          </svg>
        </span>
      </button>
    </div>
      </div>
    </Transition>
  </section>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  message: { type: Object, default: null },
});

const emit = defineEmits(['select']);

const artifacts = computed(() => {
  const content = props.message?.content || '';
  const matches = content.matchAll(/\[viz:(viz_\w+)\]/g);
  const seen = new Set();
  const items = [];

  for (const match of matches) {
    const artifactId = match[1];
    if (!artifactId || seen.has(artifactId)) continue;
    seen.add(artifactId);
    items.push({
      artifactId,
      index: items.length,
      label: `可视化 ${items.length + 1}`,
      message: props.message,
    });
  }

  return items;
});

const ARTIFACT_REVEAL_MS = 300;
const ARTIFACT_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function bindEnd(el, done) {
  const finish = (e) => {
    if (e && (e.target !== el || e.propertyName !== 'height')) return;
    el.removeEventListener('transitionend', finish);
    done();
  };
  el.addEventListener('transitionend', finish);
  return finish;
}

// 高度测量驱动的展开/收起：框架与内容作为一个整体一起动，避免分两批出现。
function onBeforeEnter(el) {
  el.style.height = '0';
  el.style.overflow = 'hidden';
}

function onEnter(el, done) {
  const target = el.scrollHeight;
  el.style.transition = `height ${ARTIFACT_REVEAL_MS}ms ${ARTIFACT_EASING}`;
  void el.offsetHeight; // 强制 reflow，确保从 0 过渡到目标高度
  el.style.height = `${target}px`;
  if (prefersReducedMotion()) { done(); return; }
  bindEnd(el, done);
}

function onAfterEnter(el) {
  el.style.height = '';
  el.style.transition = '';
  el.style.overflow = '';
}

function onBeforeLeave(el) {
  el.style.height = `${el.scrollHeight}px`;
  el.style.overflow = 'hidden';
}

function onLeave(el, done) {
  void el.offsetHeight;
  el.style.transition = `height ${ARTIFACT_REVEAL_MS}ms ${ARTIFACT_EASING}`;
  el.style.height = '0';
  if (prefersReducedMotion()) { done(); return; }
  bindEnd(el, done);
}

function onAfterLeave(el) {
  el.style.height = '';
  el.style.transition = '';
  el.style.overflow = '';
}
</script>

<style scoped>
.artifact-panel {
  flex-shrink: 0;
}

.artifact-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px 6px;
}

.artifact-panel-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.2;
}

.artifact-panel-icon {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.32);
  flex-shrink: 0;
}

.artifact-panel-icon svg,
.artifact-item-action svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.artifact-count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 650;
  line-height: 18px;
  text-align: center;
}

.artifact-reveal-inner {
  border-top: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.18);
}

.artifact-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 10px 10px;
}

.artifact-item {
  width: 100%;
  min-height: 42px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 22px;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.artifact-item:hover {
  border-color: var(--color-border);
  background: var(--surface-shell);
}

.artifact-item-index {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--color-active-rgb), 0.08);
  color: var(--color-active);
  font-size: 11px;
  font-weight: 700;
}

.artifact-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.artifact-item-title {
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 1.2;
  font-weight: 650;
}

.artifact-item-id {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.2;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-item-action {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.artifact-item:hover .artifact-item-action {
  color: var(--color-text-secondary);
}
</style>

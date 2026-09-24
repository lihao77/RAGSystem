<template>
  <div class="file-tree">
    <!-- 粘性层级条：滚动出视口的祖先目录吸附在顶部，点击回到该目录的自然位置 -->
    <div v-if="stickyRows.length" class="file-tree-sticky" aria-label="当前文件层级">
      <button
        v-for="item in stickyRows"
        :key="item.path"
        type="button"
        class="file-row file-row--sticky"
        :title="item.path"
        :style="{ paddingLeft: `${10 + item.depth * 16}px` }"
        @click="scrollToSticky(item)"
      >
        <ChevronDown class="file-row__chevron" />
        <span class="file-row__name">{{ item.name }}</span>
      </button>
    </div>

    <div ref="scrollEl" class="file-tree-scroll" @scroll="onTreeScroll">
      <template v-for="node in nodes" :key="node.path">
        <button
          v-if="node.type === 'directory'"
          type="button"
          class="file-row"
          :data-tree-path="node.path"
          :title="node.path"
          :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
          @click="emit('toggle', node.path)"
        >
          <ChevronDown :class="['file-row__chevron', { 'file-row__chevron--closed': node.collapsed }]" />
          <span class="file-row__name">{{ node.name }}</span>
          <SkillFileChangeMarker :change="node.change" directory />
        </button>
        <a
          v-else-if="hrefFor"
          :href="hrefFor(node.path)"
          target="_blank"
          rel="noopener"
          class="file-row file-row--link"
          :data-tree-path="node.path"
          :title="node.path"
          :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
        >
          <component :is="iconOf(node)" :style="node.iconColor ? { color: node.iconColor } : undefined" />
          <span class="file-row__name">{{ node.name }}</span>
          <small>{{ formatSize(node.size) }}</small>
        </a>
        <button
          v-else
          type="button"
          :class="['file-row', { 'file-row--active': selectedPath === node.path }]"
          :data-tree-path="node.path"
          :title="node.path"
          :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
          @click="emit('select', node.path)"
        >
          <component :is="iconOf(node)" :style="node.iconColor ? { color: node.iconColor } : undefined" />
          <span class="file-row__name">{{ node.name }}</span>
          <small v-if="node.size != null">{{ formatSize(node.size) }}</small>
          <SkillFileChangeMarker :change="node.change" />
        </button>
      </template>
    </div>
  </div>
</template>

<script setup>
// Skill bundle 文件树：可点选编辑；只读列表（传 hrefFor 则文件渲染为下载链接）。
// iconFor(node) 可注入按文件类型区分的图标（缺省统一 FileText）；node.iconColor 可为单行图标着色。
// stickyDirs 开启"粘性层级"：滚动时已滚出视口的祖先目录吸附在滚动区顶部（VSCode 风格）。
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ChevronDown, FileText } from 'lucide-vue-next';

import { formatSize } from '../../utils/skillFiles.js';
import SkillFileChangeMarker from './SkillFileChangeMarker.vue';

const props = defineProps({
  nodes: { type: Array, required: true },
  selectedPath: { type: String, default: '' },
  hrefFor: { type: Function, default: null },
  iconFor: { type: Function, default: null },
  stickyDirs: { type: Boolean, default: false },
});

const emit = defineEmits(['select', 'toggle']);

const iconOf = (node) => (props.iconFor ? props.iconFor(node) : FileText);

/* ---- 粘性层级：滚动出视口的祖先目录吸附展示 ---- */
const scrollEl = ref(null);
const stickyRows = ref([]);
let stickyRaf = 0;

function scheduleStickyCompute() {
  if (!props.stickyDirs || stickyRaf) return;
  stickyRaf = requestAnimationFrame(() => {
    stickyRaf = 0;
    const before = stickyRows.value.length;
    computeStickyAncestors();
    // 吸附条行数变化会移动"有效顶边"，补算一次即收敛
    if (stickyRows.value.length !== before) computeStickyAncestors();
  });
}

function computeStickyAncestors() {
  const el = scrollEl.value;
  stickyRows.value = [];
  if (!el || el.scrollTop <= 0) return;
  const rows = Array.from(el.querySelectorAll('[data-tree-path]'));
  if (!rows.length) return;
  const rowHeight = rows[0].offsetHeight || 24;
  // 吸附条悬浮覆盖在滚动区顶部（不占布局，滚动条稳定）：
  // 锚点行与"已滚出"判定都以 吸附条下沿(effectiveTop) 为参照，避免条下内容半露。
  const effectiveTop = el.scrollTop + stickyRows.value.length * rowHeight;
  let anchorPath = '';
  for (const row of rows) {
    if (row.offsetTop > effectiveTop) break;
    anchorPath = row.dataset.treePath || '';
  }
  if (!anchorPath) return;
  // 祖先目录 = 路径前缀；只吸附"自然行已整体没入吸附条或滚出顶部"的那些
  const segments = anchorPath.split('/');
  const chain = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    const dirPath = segments.slice(0, depth).join('/');
    const dirEl = rows.find((row) => row.dataset.treePath === dirPath);
    if (dirEl && dirEl.offsetTop + dirEl.offsetHeight <= effectiveTop + 1) {
      chain.push({ path: dirPath, name: segments[depth - 1], depth: depth - 1 });
    }
  }
  stickyRows.value = chain;
}

function onTreeScroll() {
  scheduleStickyCompute();
}

function scrollToSticky(item) {
  const el = scrollEl.value;
  if (!el) return;
  const target = el.querySelector(`[data-tree-path="${CSS.escape(item.path)}"]`);
  if (!target) return;
  const stickyHeight = stickyRows.value.length * (target.offsetHeight || 24);
  // 回退一个吸附条高度，让目标目录的自然行落在吸附条之下
  el.scrollTo({ top: Math.max(0, target.offsetTop - stickyHeight), behavior: 'smooth' });
}

onMounted(scheduleStickyCompute);
onUnmounted(() => {
  if (stickyRaf) cancelAnimationFrame(stickyRaf);
});
// 展开/折叠/懒加载改变行集合后重算（含滚动位置被动变化的场景）
watch(() => props.nodes, () => nextTick(scheduleStickyCompute));
</script>

<style scoped>
.file-tree {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

/* 覆盖式吸附条：绝对定位悬浮在滚动区顶部，不占布局——
   滚动容器高度恒定，滚动条不会随吸附条出现/变高而跳动。 */
.file-tree-sticky {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  background: var(--surface-sidebar);
  padding: var(--spacing-xs) var(--spacing-xs) 0;
}

.file-tree-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-xs);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding-top: 4px;
  padding-right: 8px;
  padding-bottom: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-align: left;
  text-decoration: none;
}

button.file-row {
  cursor: pointer;
}

button.file-row:hover,
.file-row--active,
.file-row--link:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.file-row--active {
  box-shadow: inset 2px 0 0 var(--color-brand-accent);
}

.file-row--link:focus-visible {
  outline: 2px solid var(--color-brand-accent);
  outline-offset: -2px;
}

.file-row svg {
  width: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.file-row__chevron {
  transition: transform var(--transition-fast);
}

.file-row__chevron--closed {
  transform: rotate(-90deg);
}

.file-row__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-row--link:hover .file-row__name {
  text-decoration: underline;
}

.file-row small {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
}
</style>

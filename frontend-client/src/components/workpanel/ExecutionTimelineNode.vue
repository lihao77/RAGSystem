<template>
  <!-- 编排层:不再渲染卡片本体,按节点类型分发到 ActionRow / ThoughtRow,
       有 children 时递归渲染子列表(子列表经 buildActionRows 分组)。 -->
  <div class="etn" :class="{ 'etn--nested': depth > 0 }">
    <ExecutionThoughtRow
      v-if="node.type === 'thought'"
      :node="node"
      :depth="depth"
      :selected-key="selectedKey"
      @inspect="emit('inspect', $event)"
      @layout-change="emit('layoutChange')"
    />
    <ExecutionActionRow
      v-else
      :node="node"
      :depth="depth"
      :selected-key="selectedKey"
      :expanded="expanded"
      @inspect="emit('inspect', $event)"
      @toggle="handleToggle"
    />

    <!-- thought 的工具流恒可见,直接渲染不走高度动画(避免 content-visibility 干扰测量) -->
    <div v-if="isThought && hasChildren" class="etn-children etn-children--thought">
      <ExecutionNodeRows
        :nodes="node.children"
        :depth="depth + 1"
        :session-id="sessionId"
        :focus-key="focusKey"
        :selected-key="selectedKey"
        :expanded-groups="expandedGroups"
        @inspect="emit('inspect', $event)"
        @toggle-group="toggleGroup"
        @layout-change="emit('layoutChange')"
      />
    </div>

    <Transition
      v-else-if="hasChildren"
      name="etn-expand"
      @before-enter="prepareExpandEnter"
      @enter="runExpandEnter"
      @after-enter="finishExpandTransition"
      @enter-cancelled="finishExpandTransition"
      @before-leave="prepareExpandLeave"
      @leave="runExpandLeave"
      @after-leave="finishExpandTransition"
      @leave-cancelled="finishExpandTransition"
    >
      <div v-if="expanded" class="etn-children">
        <ExecutionNodeRows
          :nodes="node.children"
          :depth="depth + 1"
          :session-id="sessionId"
          :focus-key="focusKey"
          :selected-key="selectedKey"
          :expanded-groups="expandedGroups"
          @inspect="emit('inspect', $event)"
          @toggle-group="toggleGroup"
          @layout-change="emit('layoutChange')"
        />
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  getExecutionNodeKey as getNodeKey,
  normalizeExecutionStatus as normalizeStatus,
} from '../../utils/executionTreePresentation'
import ExecutionActionRow from './ExecutionActionRow.vue'
import ExecutionThoughtRow from './ExecutionThoughtRow.vue'
import ExecutionNodeRows from './ExecutionNodeRows.vue'

defineOptions({ name: 'ExecutionTimelineNode' })

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  sessionId: { type: String, default: '' },
  focusKey: { type: String, default: '' },
  selectedKey: { type: String, default: '' },
  // 组展开态由顶层集中持有(选中组内节点时需跨层级展开),经 props 下传、事件上报。
  expandedGroups: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['inspect', 'toggleGroup', 'layoutChange'])

const expanded = ref(defaultExpanded(props.node))
const EXPAND_TRANSITION_MS = 230
const EXPAND_TRANSITION_EASE = 'var(--ease-out-expo)'
const DEFAULT_EXPAND_GAP_PX = 5

const nodeKeyValue = computed(() => getNodeKey(props.node))
const hasChildren = computed(() => Array.isArray(props.node.children) && props.node.children.length > 0)
// thought 是"段落引导":它带出的工具流必须始终可见地跟在后面,默认且不折叠。
// (旧版 thought 是可展开卡片;新版排版成换气记号后,子步骤仍要自然流出。)
const isThought = computed(() => props.node.type === 'thought')

watch(
  () => [props.focusKey, props.node.status, props.node.children?.length],
  () => {
    if (hasChildren.value && shouldRevealNode(props.node, props.focusKey)) {
      expanded.value = true
    }
  },
  { immediate: true }
)

watch(nodeKeyValue, () => {
  expanded.value = defaultExpanded(props.node)
})

// ActionRow 头部点击只负责 inspect;展开/收起由 chevron 行点击触发——
// 这里监听 children 区域的切换,头部点击仍展开(有子节点时点行=看详情+展开)。
// 为保持"点行打开 Inspector"与"展开子树"都可达,头部点击在 ActionRow 内 emit inspect;
// 本层通过监听 selectedKey 变化不强制展开,保留 shouldRevealNode 的自动展开。

watch(expanded, () => emit('layoutChange'), { flush: 'post' })

function handleToggle() {
  if (hasChildren.value) expanded.value = !expanded.value
}

function toggleGroup(groupKey) {
  emit('toggleGroup', groupKey)
}

function defaultExpanded(node) {
  if (node.expanded !== undefined) return Boolean(node.expanded)
  return shouldRevealNode(node, props.focusKey)
}

function shouldRevealNode(node, focusKey) {
  if (!node) return false
  const status = normalizeStatus(node.status)
  if (status === 'running' || status === 'error') return true
  if (node.tool_name === 'request_user_input') return true
  if (hasRunningChild(node) || hasErrorChild(node)) return true
  return Boolean(focusKey && containsNodeKey(node, focusKey))
}

function hasRunningChild(node) {
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => normalizeStatus(child.status) === 'running' || hasRunningChild(child))
}

function hasErrorChild(node) {
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => normalizeStatus(child.status) === 'error' || hasErrorChild(child))
}

function containsNodeKey(node, key) {
  if (!key || !node) return false
  if (getNodeKey(node) === key) return true
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => containsNodeKey(child, key))
}

function prepareExpandEnter(el) {
  if (shouldReduceMotion()) return
  Object.assign(el.style, {
    height: '0px',
    paddingTop: '0px',
    opacity: '0',
    overflow: 'hidden',
    willChange: 'height, padding-top, opacity',
  })
}

function runExpandEnter(el, done) {
  if (shouldReduceMotion()) {
    done()
    return
  }
  el.style.transition = expandTransition()
  requestAnimationFrame(() => {
    const gap = getExpandGapPx(el)
    el.style.height = `${el.scrollHeight + gap}px`
    el.style.paddingTop = `${gap}px`
    el.style.opacity = '1'
  })
  finishAfterHeightTransition(el, done)
}

function prepareExpandLeave(el) {
  if (shouldReduceMotion()) return
  const styles = getComputedStyle(el)
  Object.assign(el.style, {
    height: `${el.scrollHeight}px`,
    paddingTop: styles.paddingTop,
    opacity: '1',
    overflow: 'hidden',
    willChange: 'height, padding-top, opacity',
  })
}

function runExpandLeave(el, done) {
  if (shouldReduceMotion()) {
    done()
    return
  }
  el.style.transition = expandTransition()
  void el.offsetHeight
  requestAnimationFrame(() => {
    el.style.height = '0px'
    el.style.paddingTop = '0px'
    el.style.opacity = '0'
  })
  finishAfterHeightTransition(el, done)
}

function finishExpandTransition(el) {
  const animatedStyles = ['height', 'paddingTop', 'opacity', 'overflow', 'transition', 'willChange']
  animatedStyles.forEach((name) => {
    el.style[name] = ''
  })
  emit('layoutChange')
}

function finishAfterHeightTransition(el, done) {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onTransitionEnd)
    done()
  }
  const onTransitionEnd = (event) => {
    if (event.target === el && event.propertyName === 'height') finish()
  }
  el.addEventListener('transitionend', onTransitionEnd)
  window.setTimeout(finish, EXPAND_TRANSITION_MS + 80)
}

function expandTransition() {
  return [
    `height ${EXPAND_TRANSITION_MS}ms ${EXPAND_TRANSITION_EASE}`,
    `padding-top ${EXPAND_TRANSITION_MS}ms ${EXPAND_TRANSITION_EASE}`,
    `opacity 160ms ease`,
  ].join(', ')
}

function getExpandGapPx(el) {
  const value = parseFloat(getComputedStyle(el).getPropertyValue('--child-gap'))
  return Number.isFinite(value) ? value : DEFAULT_EXPAND_GAP_PX
}

function shouldReduceMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}
</script>

<style scoped>
.etn {
  /* 父行 svg 图标中心距行左缘:padding-left(4) + icon(18)/2 = 13px。
     子树竖线必须落在父图标中心线上,故缩进=13px。 */
  --child-indent: 13px;
  position: relative;
  letter-spacing: 0;
}

.etn--nested {
  --child-indent: 13px;
}

/* 子树:缩进 + 一条 hairline indent guide(系统 border 色),竖线对齐父图标中心。
   子项内容再右 pad,与竖线留出呼吸。 */
.etn-children {
  --child-gap: 2px;
  position: relative;
  box-sizing: border-box;
  margin: 0 0 0 var(--child-indent);
  padding: var(--child-gap) 0 0 12px;
  border-left: 1px solid var(--color-border);
}

/* thought 的工具流是同层延续(思考引出一段行动),不缩进、不画 guide 线。 */
.etn-children--thought {
  margin-left: 0;
  padding-left: 0;
  border-left: 0;
}

.etn-children > * {
  position: relative;
  z-index: 1;
}

.etn-expand-enter-active,
.etn-expand-leave-active {
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .etn-expand-enter-active,
  .etn-expand-leave-active {
    transition-duration: 1ms;
  }
}
</style>

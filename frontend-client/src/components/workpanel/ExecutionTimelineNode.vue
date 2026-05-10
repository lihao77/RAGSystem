<template>
  <div class="etn" :class="[`etn--${node.type}`, { 'etn--nested': depth > 0 }]">

    <!-- Thought node -->
    <template v-if="node.type === 'thought'">
      <div class="etn-thought-header">
        <span class="etn-thought-agent">{{ shortName(node.agent_display_name) }}</span>
        <span v-if="node.intent" class="etn-thought-intent">{{ truncate(node.intent, 80) }}</span>
      </div>
      <div v-if="node.children?.length" class="etn-children">
        <ExecutionTimelineNode
          v-for="(child, i) in node.children"
          :key="i"
          :node="child"
          :depth="depth + 1"
        />
      </div>
    </template>

    <!-- Tool call node -->
    <template v-else-if="node.type === 'tool_call'">
      <div class="etn-tool-row" @click="showDetail = !showDetail">
        <span class="etn-status-dot" :class="dotClass(node.status)">
          <span v-if="node.status === 'running'" class="etn-spinner-dot"></span>
        </span>
        <span class="etn-tool-name">{{ node.tool_name }}</span>
        <span v-if="node.elapsed_time" class="etn-time">{{ fmtTime(node.elapsed_time) }}</span>
        <span class="etn-expand-btn">{{ showDetail ? '▲' : '▼' }}</span>
      </div>
      <div v-if="showDetail" class="etn-detail">
        <div v-if="node.arguments" class="etn-detail-block">
          <div class="etn-detail-label">参数</div>
          <pre class="etn-pre">{{ fmtJson(node.arguments) }}</pre>
        </div>
        <div v-if="node.result_preview || node.result" class="etn-detail-block">
          <div class="etn-detail-label">结果</div>
          <pre class="etn-pre">{{ truncate(node.result_preview || String(node.result || ''), 400) }}</pre>
        </div>
      </div>
    </template>

    <!-- Agent call node -->
    <template v-else-if="node.type === 'agent_call'">
      <div class="etn-agent-row" @click="expanded = !expanded">
        <span class="etn-status-dot" :class="dotClass(node.status)"></span>
        <span class="etn-agent-name">{{ shortName(node.agent_display_name || node.agent_name) }}</span>
        <span v-if="node.description || node.result_summary" class="etn-agent-desc">
          {{ truncate(node.description || node.result_summary, 40) }}
        </span>
        <span v-if="node.children?.length" class="etn-expand-btn">{{ expanded ? '▲' : '▼' }}</span>
      </div>
      <div v-if="expanded && node.children?.length" class="etn-children">
        <ExecutionTimelineNode
          v-for="(child, i) in node.children"
          :key="i"
          :node="child"
          :depth="depth + 1"
        />
      </div>
    </template>

  </div>
</template>

<script setup>
import { ref } from 'vue'

defineOptions({ name: 'ExecutionTimelineNode' })

defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
})

const showDetail = ref(false)
const expanded = ref(true)

function shortName(name) {
  if (!name) return '?'
  return name.replace(/_agent$/, '').replace(/_/g, ' ')
}

function truncate(str, max) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max) + '…' : str
}

function fmtTime(ms) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtJson(val) {
  try {
    const obj = typeof val === 'string' ? JSON.parse(val) : val
    return JSON.stringify(obj, null, 2).slice(0, 600)
  } catch {
    return String(val ?? '').slice(0, 600)
  }
}

function dotClass(status) {
  if (!status || status === 'pending') return 'dot-idle'
  if (status === 'running') return 'dot-running'
  if (status === 'completed' || status === 'success') return 'dot-ok'
  if (status === 'error' || status === 'failed') return 'dot-err'
  return 'dot-idle'
}
</script>

<style scoped>
/* ── Base ─────────────────────────────── */
.etn {
  position: relative;
  padding: 0 0 0 12px;
}

/* Left border for nested children */
.etn-children {
  margin-top: 2px;
  padding-left: 8px;
  border-left: 1px solid var(--color-border);
  margin-left: 6px;
}

/* ── Thought node ─────────────────────── */
.etn-thought-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 0 3px;
}

.etn-thought-agent {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.etn-thought-intent {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Tool call node ───────────────────── */
.etn-tool-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 0;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.12s;
}

.etn-tool-row:hover {
  background: var(--color-hover-overlay, rgba(255,255,255,0.04));
}

.etn-tool-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.etn-time {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.etn-expand-btn {
  font-size: 9px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  opacity: 0.6;
}

/* ── Agent call node ──────────────────── */
.etn-agent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 0;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.12s;
}

.etn-agent-row:hover {
  background: var(--color-hover-overlay, rgba(255,255,255,0.04));
}

.etn-agent-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-brand-accent, #6366f1);
  white-space: nowrap;
  flex-shrink: 0;
  text-transform: capitalize;
}

.etn-agent-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* ── Status dot ───────────────────────── */
.etn-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  position: relative;
}

.dot-idle  { background: var(--color-border); }
.dot-ok    { background: var(--color-success, #22c55e); }
.dot-err   { background: var(--color-error, #ef4444); }
.dot-running {
  background: var(--color-brand-accent, #6366f1);
}

.etn-spinner-dot {
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1.5px solid transparent;
  border-top-color: var(--color-brand-accent, #6366f1);
  animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ── Inline detail ────────────────────── */
.etn-detail {
  margin: 3px 0 6px 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.etn-detail-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.etn-detail-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.etn-pre {
  margin: 0;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 5px 7px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 140px;
  overflow-y: auto;
  scrollbar-width: thin;
}
</style>

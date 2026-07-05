<template>
  <div class="wpe-inspector">
    <div class="wpe-inspector-header">
      <div class="wpe-inspector-title">
        <span class="wpe-inspector-kicker">{{ inspectorTypeLabel }}</span>
        <span class="wpe-inspector-name">{{ inspectorTitle }}</span>
      </div>
      <UiIconButton class="wpe-inspector-close" variant="ghost" label="关闭详情" @click="emit('close')">
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </UiIconButton>
    </div>

    <div class="wpe-inspector-body">
      <section v-if="selectedInspectorMeta.length || selectedSummarySections.length || node.ctx?.max > 0" class="wpe-inspector-section">
        <div class="wpe-section-heading heading-summary">
          <span class="wpe-section-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="M4 5.8C4 4.8 4.8 4 5.8 4h8.4c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8V5.8Z" />
              <path d="M7 7.5h6" />
              <path d="M7 10h6" />
              <path d="M7 12.5h3.5" />
            </svg>
          </span>
          <span>摘要</span>
        </div>
        <div v-if="selectedInspectorMeta.length" class="wpe-meta-grid">
          <div
            v-for="item in selectedInspectorMeta"
            :key="item.label"
            class="wpe-meta-item"
            :class="metaItemClass(item)"
            :title="`${item.label}: ${item.value}`"
          >
            <span class="wpe-meta-label">{{ item.label }}</span>
            <span class="wpe-meta-value">{{ item.value }}</span>
          </div>
        </div>
        <div v-for="section in selectedSummarySections" :key="section.id" class="wpe-detail-block">
          <div class="wpe-detail-label">{{ section.label }}</div>
          <div class="wpe-detail-text">{{ section.text }}</div>
        </div>
        <div v-if="node.ctx?.max > 0" class="wpe-context">
          <div class="wpe-context-copy">
            <span>上下文</span>
            <span>{{ selectedCtxPercent }}%</span>
          </div>
          <div class="wpe-context-track">
            <span class="wpe-context-fill" :style="{ width: selectedCtxPercent + '%' }"></span>
          </div>
        </div>
      </section>

      <section v-if="selectedInputSections.length" class="wpe-inspector-section">
        <div class="wpe-section-heading heading-input">
          <span class="wpe-section-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="M4 10h8.5" />
              <path d="m9 6.5 3.5 3.5L9 13.5" />
              <path d="M14 4.5h1.2c.9 0 1.6.7 1.6 1.6v7.8c0 .9-.7 1.6-1.6 1.6H14" />
            </svg>
          </span>
          <span>输入</span>
        </div>
        <div v-for="section in selectedInputSections" :key="section.id" class="wpe-detail-block">
          <div class="wpe-detail-label">{{ section.label }}</div>
          <div v-if="section.kind === 'code'" class="wpe-code-wrap">
            <UiIconButton
              class="wpe-copy-btn"
              variant="ghost"
              :label="copiedSectionId === section.id ? '已复制' : '复制'"
              :title="copiedSectionId === section.id ? '已复制' : '复制'"
              @click="copySectionText(section)"
            >
              <svg v-if="copiedSectionId === section.id" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                <path d="m4.5 10.5 3.2 3.2 7.8-8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
                <path d="M4 12V5.8C4 4.8 4.8 4 5.8 4H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </UiIconButton>
            <pre class="wpe-code">{{ section.text }}</pre>
          </div>
          <div v-else class="wpe-detail-text">{{ section.text }}</div>
          <div v-if="section.options?.length" class="wpe-options">
            <span v-for="option in section.options" :key="option" class="wpe-option">{{ option }}</span>
          </div>
        </div>
      </section>

      <section v-if="selectedOutputSections.length" class="wpe-inspector-section">
        <div class="wpe-section-heading heading-output">
          <span class="wpe-section-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="M4.5 5.5h11v5h-11z" />
              <path d="M6 13.5h8" />
              <path d="M8 16h4" />
              <path d="M7.5 8h5" />
            </svg>
          </span>
          <span>输出</span>
        </div>
        <div v-for="section in selectedOutputSections" :key="section.id" class="wpe-detail-block">
          <div class="wpe-detail-label">{{ section.label }}</div>
          <div v-if="section.kind === 'code'" class="wpe-code-wrap">
            <UiIconButton
              class="wpe-copy-btn"
              variant="ghost"
              :label="copiedSectionId === section.id ? '已复制' : '复制'"
              :title="copiedSectionId === section.id ? '已复制' : '复制'"
              @click="copySectionText(section)"
            >
              <svg v-if="copiedSectionId === section.id" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                <path d="m4.5 10.5 3.2 3.2 7.8-8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
                <path d="M4 12V5.8C4 4.8 4.8 4 5.8 4H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </UiIconButton>
            <pre class="wpe-code result">{{ section.text }}</pre>
          </div>
          <div v-else class="wpe-detail-text" :class="{ muted: section.muted }">{{ section.text }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  formatToolContent,
  getToolDisplayName as resolveToolDisplayName,
  getToolInputSections as resolveToolInputSections,
  getToolInspectorLabel as resolveToolInspectorLabel,
  getToolInspectorMeta as resolveToolInspectorMeta,
  getToolOutputSections as resolveToolOutputSections,
  getToolSummarySections as resolveToolSummarySections,
  hasToolArguments,
  parseToolPayload,
} from '../../utils/toolPresentation'
import { UiIconButton } from '../ui'

const props = defineProps({
  node: { type: Object, required: true },
})
const emit = defineEmits(['close'])

const copiedSectionId = ref('')
let copiedResetTimer = null

const selectedToolPayload = computed(() => props.node.type === 'tool_call' ? parseToolPayload(props.node) : null)
const selectedPreviewResult = computed(() => selectedToolPayload.value?.preview ?? props.node.result_preview ?? props.node.result ?? '')
const selectedArguments = computed(() => selectedToolPayload.value?.args || {})
const hasSelectedArguments = computed(() => props.node.type === 'tool_call' ? hasToolArguments(props.node) : false)
const formattedSelectedArguments = computed(() => formatToolContent(hasSelectedArguments.value ? selectedArguments.value : props.node.arguments, 1600))
const formattedSelectedResult = computed(() => formatToolContent(selectedPreviewResult.value, 1600))

const selectedCtxPercent = computed(() => {
  const ctx = props.node.ctx
  if (!ctx?.max) return 0
  return Math.min(100, Math.round((ctx.used / ctx.max) * 100))
})

const selectedStatusLabel = computed(() => {
  const label = {
    running: '执行中',
    success: '完成',
    error: '失败',
    stopped: '已停止',
    pending: '等待',
  }
  return label[normalizeStatus(props.node.status)] || props.node.status || '未知'
})

const selectedElapsedLabel = computed(() => formatElapsed(props.node.elapsed_time))

const selectedInspectorMeta = computed(() => {
  const node = props.node
  const meta = [{ label: '状态', value: selectedStatusLabel.value }]
  if (selectedElapsedLabel.value) meta.push({ label: '耗时', value: selectedElapsedLabel.value })
  if (node.type === 'agent_call') {
    const agent = node.agent_display_name || node.agent_name || node.agent
    if (agent) meta.push({ label: 'Agent', value: agent })
  }
  if (node.type === 'tool_call' && node.tool_name) meta.push({ label: '工具', value: node.tool_name })
  if (node.type === 'tool_call') {
    meta.push(...resolveToolInspectorMeta(node))
  }
  if (node.type === 'thought' && node.round) meta.push({ label: '轮次', value: String(node.round) })
  return dedupeMeta(meta).slice(0, 10)
})

const selectedSummarySections = computed(() => {
  const node = props.node
  if (node.type === 'agent_call' && node.description) {
    return [{ id: 'summary-agent-task', label: '任务', text: node.description }]
  }
  if (node.type === 'thought') {
    const text = node.intent || node.thought || node.thinking || node.description || inspectorTitle.value
    return text ? [{ id: 'summary-thought', label: '内容', text }] : []
  }
  if (node.type !== 'tool_call') {
    const text = node.description || inspectorTitle.value
    return text ? [{ id: 'summary-content', label: '内容', text }] : []
  }
  return resolveToolSummarySections(node)
})

const selectedInputSections = computed(() => {
  const node = props.node
  if (node.type !== 'tool_call') return []
  const specialized = resolveToolInputSections(node)
  if (specialized.length) return specialized
  if (!hasSelectedArguments.value) return []
  return [{ id: 'input-args', label: '参数', text: formattedSelectedArguments.value, kind: 'code' }]
})

const selectedOutputSections = computed(() => {
  const node = props.node
  if (node.type === 'agent_call' && node.result_summary) {
    return [{ id: 'output-agent-result', label: '结果', text: node.result_summary }]
  }
  if (node.type !== 'tool_call') return []
  const specialized = resolveToolOutputSections(node)
  if (specialized.length) return specialized
  if (!selectedPreviewResult.value) return []
  return [{ id: 'output-result', label: '执行结果', text: formattedSelectedResult.value, kind: 'code' }]
})

const inspectorTypeLabel = computed(() => {
  if (props.node.type === 'agent_call') return 'Agent 详情'
  if (props.node.type === 'tool_call') return resolveToolInspectorLabel(props.node.tool_name)
  if (props.node.type === 'thought') return props.node.round ? `轮次 ${props.node.round}` : '思考详情'
  return '执行详情'
})

const inspectorTitle = computed(() => {
  const node = props.node
  if (node.type === 'agent_call') return node.agent_display_name || node.agent_name || node.description || 'Agent'
  if (node.type === 'tool_call') return resolveToolDisplayName(node)
  return node.intent || node.thought || node.thinking || node.description || '执行步骤'
})

watch(
  () => props.node,
  () => {
    copiedSectionId.value = ''
  }
)

onUnmounted(() => {
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
})

function normalizeStatus(status) {
  if (status === 'completed' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'stopped') return 'stopped'
  if (status === 'running') return 'running'
  return status || 'pending'
}

function formatElapsed(value) {
  if (value === null || value === undefined || value === '') return ''
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest}s`
}

async function copyToClipboard(text) {
  const value = String(text || '')
  if (!value) return false
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function' &&
      typeof window !== 'undefined' &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the textarea fallback.
  }

  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return Boolean(document.execCommand && document.execCommand('copy'))
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

async function copySectionText(section) {
  const text = String(section?.text || '')
  if (!text) return
  const ok = await copyToClipboard(text)
  if (!ok) return
  copiedSectionId.value = section.id
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
  copiedResetTimer = setTimeout(() => {
    if (copiedSectionId.value === section.id) copiedSectionId.value = ''
  }, 1200)
}

function metaItemClass(item) {
  if (item?.label !== '状态') return ''
  const value = String(item.value || '')
  if (value.includes('失败')) return 'meta-status-error'
  if (value.includes('完成')) return 'meta-status-success'
  if (value.includes('执行') || value.includes('等待')) return 'meta-status-running'
  if (value.includes('停止')) return 'meta-status-stopped'
  return ''
}

function dedupeMeta(items) {
  const seen = new Set()
  return items.filter(item => {
    const key = item.label
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
</script>

<style scoped>
.wpe-inspector {
  height: 100%;
  min-height: 0;
  max-height: 100%;
  border-top: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.9);
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
  display: flex;
  flex-direction: column;
  transform-origin: bottom;
  will-change: transform, opacity;
  box-shadow:
    0 -14px 28px rgba(0, 0, 0, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.wpe-inspector-header {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 9px;
  border-bottom: none;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.52);
  flex-shrink: 0;
}

.wpe-inspector-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 8%;
  right: 8%;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-border) 70%, transparent) 20%, color-mix(in srgb, var(--color-border) 70%, transparent) 80%, transparent);
}

.wpe-inspector-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wpe-inspector-kicker {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-inspector-name {
  font-size: 12px;
  line-height: 1.35;
  font-weight: 650;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-inspector-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.wpe-inspector-close:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.wpe-inspector-body {
  min-height: 0;
  overflow: auto;
  padding: 10px 14px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-inspector-body::-webkit-scrollbar {
  width: 4px;
}

.wpe-inspector-body::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-full);
}

.wpe-inspector-section {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 68%, transparent);
}

.wpe-inspector-section:first-child {
  padding-top: 0;
  border-top: 0;
}

.wpe-section-heading {
  --section-tone: var(--color-text-muted);
  --section-tone-rgb: var(--color-text-muted-rgb, 142, 142, 147);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: none;
}

.heading-summary {
  --section-tone: var(--color-brand-accent);
  --section-tone-rgb: var(--color-brand-accent-rgb);
}

.heading-input {
  --section-tone: var(--color-warning);
  --section-tone-rgb: var(--color-warning-rgb);
}

.heading-output {
  --section-tone: var(--color-success);
  --section-tone-rgb: var(--color-success-rgb);
}

.wpe-section-icon {
  width: 18px;
  height: 18px;
  border-radius: 6px;
  border: 1px solid rgba(var(--section-tone-rgb), 0.24);
  background: rgba(var(--section-tone-rgb), 0.08);
  color: var(--section-tone);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.wpe-section-icon svg {
  width: 12px;
  height: 12px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.wpe-meta-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.wpe-meta-item {
  --meta-tone: var(--color-text-muted);
  --meta-tone-rgb: var(--color-bg-elevated-rgb, 28, 28, 30);
  max-width: 100%;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.3);
  color: var(--color-text-secondary);
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.wpe-meta-label {
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.wpe-meta-value {
  min-width: 0;
  font-size: 11px;
  line-height: 1;
  color: currentColor;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-meta-item.meta-status-success {
  --meta-tone: var(--color-success);
  --meta-tone-rgb: var(--color-success-rgb);
}

.wpe-meta-item.meta-status-running {
  --meta-tone: var(--color-brand-accent);
  --meta-tone-rgb: var(--color-brand-accent-rgb);
}

.wpe-meta-item.meta-status-error {
  --meta-tone: var(--color-error);
  --meta-tone-rgb: var(--color-error-rgb);
}

.wpe-meta-item.meta-status-stopped {
  --meta-tone: var(--color-warning);
  --meta-tone-rgb: var(--color-warning-rgb);
}

.wpe-meta-item[class*="meta-status-"] {
  border-color: rgba(var(--meta-tone-rgb), 0.24);
  background: rgba(var(--meta-tone-rgb), 0.08);
  color: var(--meta-tone);
}

.wpe-meta-item[class*="meta-status-"] .wpe-meta-label {
  color: var(--meta-tone);
}

.wpe-detail-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding: 9px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.16);
}

.wpe-detail-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-detail-label::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-border-hover);
  flex-shrink: 0;
}

.wpe-detail-text {
  max-height: 132px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-detail-text::-webkit-scrollbar,
.wpe-code::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.wpe-detail-text::-webkit-scrollbar-thumb,
.wpe-code::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-full);
}

.wpe-detail-text.muted,
.muted {
  color: var(--color-text-muted);
}

.wpe-code-wrap {
  position: relative;
  min-width: 0;
}

.wpe-copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.82);
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.wpe-copy-btn:hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.96);
}

.wpe-code {
  margin: 0;
  max-height: 210px;
  overflow: auto;
  padding: 9px 38px 9px 10px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  color: var(--color-text-secondary);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-code.result {
  color: var(--color-result-text);
  background: var(--color-result-bg);
  border-color: var(--color-result-border);
}

.wpe-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wpe-option {
  max-width: 100%;
  padding: 3px 7px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-context {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.16);
}

.wpe-context-copy {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.wpe-context-track {
  height: 4px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--color-border);
}

.wpe-context-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-brand-accent);
  transition: width var(--duration-stage) ease;
}

@media (prefers-reduced-motion: reduce) {
  .wpe-inspector-close,
  .wpe-context-fill {
    transition-duration: 1ms;
  }
}
</style>

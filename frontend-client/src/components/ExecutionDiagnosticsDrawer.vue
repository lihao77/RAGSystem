<template>
  <Teleport to="body">
    <Transition name="exec-drawer-fade">
      <div v-if="visible" class="ed-overlay" @click="$emit('close')">
        <aside class="ed-drawer" @click.stop>

          <!-- Header -->
          <div class="ed-header">
            <div class="ed-header-left">
              <div class="ed-header-icon" :class="statusClass">
                <svg v-if="isRunning" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                </svg>
                <svg v-else-if="statusClass === 'is-success'" xmlns="http://www.w3.org/2000/svg" width="18" height="18"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <svg v-else-if="statusClass === 'is-error'" xmlns="http://www.w3.org/2000/svg" width="18" height="18"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
              </div>
              <div class="ed-header-text">
                <h3>执行诊断</h3>
                <span class="ed-header-sub">{{ kindLabel }}</span>
              </div>
            </div>
            <button class="ed-close-btn" @click="$emit('close')" title="关闭">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <!-- Body -->
          <div class="ed-body">
            <div v-if="loading" class="ed-state">
              <div class="ed-spinner"></div>
              <span>加载中...</span>
            </div>
            <div v-else-if="errorMsg" class="ed-state ed-state--error">
              <span>{{ errorMsg }}</span>
            </div>
            <template v-else>

              <!-- Status Hero -->
              <div class="ed-status-hero" :class="statusClass">
                <div class="ed-status-indicator">
                  <span class="ed-status-dot" :class="statusClass"></span>
                  <span class="ed-status-label">{{ statusText }}</span>
                </div>
                <div class="ed-status-meta">
                  <span v-if="elapsed != null" class="ed-meta-chip">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="10"></circle>
                      <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    {{ formatElapsed(elapsed) }}
                  </span>
                  <span class="ed-meta-chip">{{ kindLabel }}</span>
                </div>
              </div>

              <!-- Observability -->
              <section class="ed-section">
                <div class="ed-section-head">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                  <span>可观测性</span>
                </div>
                <div class="ed-kv-grid">
                  <div class="ed-kv-item" v-for="item in observabilityItems" :key="item.label">
                    <span class="ed-kv-label">{{ item.label }}</span>
                    <div class="ed-kv-right">
                      <code class="ed-kv-value ed-kv-mono" :title="item.value">{{ item.display }}</code>
                      <button
                        v-if="item.value !== '—'"
                        class="ed-copy-btn"
                        :class="{ 'is-copied': copiedKey === item.label }"
                        :title="copiedKey === item.label ? '已复制' : '复制'"
                        @click="copyId(item.label, item.value)"
                      >
                        <svg v-if="copiedKey !== item.label" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <svg v-else xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <!-- Runner -->
              <section class="ed-section">
                <div class="ed-section-head">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line>
                    <line x1="12" y1="17" x2="12" y2="21"></line>
                  </svg>
                  <span>运行时状态</span>
                </div>
                <div class="ed-runtime-grid">
                  <div class="ed-runtime-card">
                    <span class="ed-runtime-label">执行状态</span>
                    <span class="ed-runtime-value">
                      <span class="ed-badge" :class="taskStatusBadgeClass">{{ taskInfo?.status || '—' }}</span>
                    </span>
                  </div>
                  <div class="ed-runtime-card">
                    <span class="ed-runtime-label">Runner 状态</span>
                    <span class="ed-runtime-value">
                      <span class="ed-badge" :class="runnerStatusBadgeClass">{{ diagnostics?.runner?.status || '—' }}</span>
                    </span>
                  </div>
                  <div class="ed-runtime-card">
                    <span class="ed-runtime-label">线程存活</span>
                    <span class="ed-runtime-value">
                      <span class="ed-bool-dot" :class="threadAliveClass"></span>
                      {{ threadAliveText }}
                    </span>
                  </div>
                  <div class="ed-runtime-card">
                    <span class="ed-runtime-label">句柄注册</span>
                    <span class="ed-runtime-value">
                      <span class="ed-bool-dot" :class="handleRegisteredClass"></span>
                      {{ handleRegisteredText }}
                    </span>
                  </div>
                </div>
              </section>

              <!-- Runner Diagnostics (if has extra runner info) -->
              <section v-if="diagnostics?.runner?.thread_alive != null" class="ed-section">
                <div class="ed-section-head">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                  </svg>
                  <span>Runner 详情</span>
                </div>
                <div class="ed-kv-grid">
                  <div class="ed-kv-item">
                    <span class="ed-kv-label">runner.status</span>
                    <code class="ed-kv-value">{{ diagnostics?.runner?.status || '—' }}</code>
                  </div>
                  <div class="ed-kv-item">
                    <span class="ed-kv-label">runner.thread_alive</span>
                    <code class="ed-kv-value">{{ diagnostics?.runner?.thread_alive ?? '—' }}</code>
                  </div>
                </div>
              </section>

            </template>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  visible: Boolean,
  loading: Boolean,
  errorMsg: { type: String, default: '' },
  taskInfo: { type: Object, default: null },
  observability: { type: Object, default: null },
  diagnostics: { type: Object, default: null },
  sessionId: { type: String, default: '' },
  isExecuting: { type: Boolean, default: false },
});

defineEmits(['close']);

const copiedKey = ref('');
let copiedTimer = null;

const copyId = async (label, value) => {
  if (!value || value === '—') return;
  try {
    await navigator.clipboard.writeText(value);
    copiedKey.value = label;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedKey.value = ''; }, 1500);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copiedKey.value = label;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedKey.value = ''; }, 1500);
  }
};

const isRunning = computed(() => {
  if (props.isExecuting) return true;
  const runnerStatus = props.diagnostics?.runner?.status;
  const taskStatus = props.taskInfo?.status;
  const s = runnerStatus ?? taskStatus;
  return s === 'running' || s === 'cancel_requested' || s === 'active';
});

const statusText = computed(() => {
  const runnerStatus = props.diagnostics?.runner?.status;
  const taskStatus = props.taskInfo?.status;
  const s = props.isExecuting ? 'running' : (runnerStatus ?? taskStatus);
  if (s === 'cancel_requested') return '停止中';
  if (s === 'running' || s === 'active') return '运行中';
  if (s === 'interrupted') return '已中断';
  if (s === 'failed') return '失败';
  if (s === 'completed') return '已完成';
  return '空闲';
});

const statusClass = computed(() => {
  const runnerStatus = props.diagnostics?.runner?.status;
  const taskStatus = props.taskInfo?.status;
  const s = props.isExecuting ? 'running' : (runnerStatus ?? taskStatus);
  if (s === 'cancel_requested') return 'is-warning';
  if (s === 'running' || s === 'active') return 'is-running';
  if (s === 'failed') return 'is-error';
  if (s === 'interrupted') return 'is-warning';
  if (s === 'completed') return 'is-success';
  return 'is-running';
});

const kindLabel = computed(() => {
  const kind = props.observability?.execution_kind || 'agent_stream';
  const labels = {
    agent_stream: 'Agent Stream',
    node_execute: 'Node Execute',
    mcp_tool_call: 'MCP Tool',
    mcp_connect: 'MCP Connect',
    mcp_disconnect: 'MCP Disconnect',
    mcp_refresh: 'MCP Refresh',
    mcp_test: 'MCP Test',
  };
  return labels[kind] || kind;
});

const elapsed = computed(() => {
  const diagnosticsElapsed = props.diagnostics?.task?.elapsed_seconds;
  if (diagnosticsElapsed != null) return diagnosticsElapsed;
  return props.taskInfo?.elapsed_seconds ?? null;
});

const formatElapsed = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
};

const truncateId = (id, len = 12) => {
  if (!id) return '—';
  if (id.length <= len) return id;
  return id.slice(0, len) + '…';
};

const observabilityItems = computed(() => {
  const obs = props.observability || {};
  return [
    { label: 'task_id', value: obs.task_id || '—', display: truncateId(obs.task_id, 16) },
    { label: 'session_id', value: obs.session_id || props.sessionId || '—', display: truncateId(obs.session_id || props.sessionId, 16) },
    { label: 'run_id', value: obs.run_id || '—', display: truncateId(obs.run_id, 16) },
    { label: 'request_id', value: obs.request_id || '—', display: truncateId(obs.request_id, 16) },
  ];
});

const taskStatusBadgeClass = computed(() => {
  const s = props.taskInfo?.status;
  if (s === 'running') return 'ed-badge--running';
  if (s === 'completed') return 'ed-badge--success';
  if (s === 'failed') return 'ed-badge--error';
  if (s === 'interrupted' || s === 'cancel_requested') return 'ed-badge--warning';
  return '';
});

const runnerStatusBadgeClass = computed(() => {
  const s = props.diagnostics?.runner?.status;
  if (!s || s === '—') return '';
  if (s === 'running' || s === 'active') return 'ed-badge--running';
  if (s === 'completed' || s === 'done') return 'ed-badge--success';
  if (s === 'failed' || s === 'error') return 'ed-badge--error';
  return '';
});

const threadAliveClass = computed(() => {
  const v = props.diagnostics?.runner?.thread_alive ?? props.taskInfo?.thread_alive;
  if (v === true) return 'is-alive';
  if (v === false) return 'is-dead';
  return '';
});

const threadAliveText = computed(() => {
  const v = props.diagnostics?.runner?.thread_alive ?? props.taskInfo?.thread_alive;
  if (v === true) return '存活';
  if (v === false) return '已停止';
  return '—';
});

const handleRegisteredClass = computed(() => {
  const v = props.diagnostics?.handle_registered;
  if (v === true) return 'is-alive';
  if (v === false) return 'is-dead';
  return '';
});

const handleRegisteredText = computed(() => {
  const v = props.diagnostics?.handle_registered;
  if (v === true) return '已注册';
  if (v === false) return '未注册';
  return '—';
});
</script>

<style scoped>
/* ===== Overlay & Drawer Shell ===== */
.ed-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: var(--z-modal, 2000);
  display: flex;
  justify-content: flex-end;
}

.ed-drawer {
  width: min(480px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-primary);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.2);
  border-left: 1px solid var(--color-border);
}

/* ===== Header ===== */
.ed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-primary);
  position: sticky;
  top: 0;
  z-index: 1;
}

.ed-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.ed-header-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--transition-fast);
}

.ed-header-icon.is-running {
  color: var(--color-brand-accent-light);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  border: 1px solid rgba(var(--color-brand-accent-rgb), 0.25);
}

.ed-header-icon.is-success {
  color: var(--color-success);
  background: rgba(var(--color-success-rgb), 0.12);
  border: 1px solid rgba(var(--color-success-rgb), 0.25);
}

.ed-header-icon.is-error {
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.12);
  border: 1px solid rgba(var(--color-error-rgb), 0.25);
}

.ed-header-icon.is-warning {
  color: var(--color-warning);
  background: rgba(var(--color-warning-rgb), 0.12);
  border: 1px solid rgba(var(--color-warning-rgb), 0.25);
}

.ed-header-text h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.ed-header-sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.ed-close-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--transition-fast);
}

.ed-close-btn:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

/* ===== Body ===== */
.ed-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ===== Loading / Error ===== */
.ed-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: 48px 20px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.ed-state--error {
  color: var(--color-error);
}

.ed-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-brand-accent-light);
  border-radius: 50%;
  animation: ed-spin 0.8s linear infinite;
}

@keyframes ed-spin {
  to { transform: rotate(360deg); }
}

/* ===== Status Hero ===== */
.ed-status-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  transition: border-color var(--transition-fast);
}

.ed-status-hero.is-running {
  border-color: rgba(var(--color-brand-accent-rgb), 0.3);
  background: rgba(var(--color-brand-accent-rgb), 0.04);
}

.ed-status-hero.is-success {
  border-color: rgba(var(--color-success-rgb), 0.3);
  background: rgba(var(--color-success-rgb), 0.04);
}

.ed-status-hero.is-error {
  border-color: rgba(var(--color-error-rgb), 0.3);
  background: rgba(var(--color-error-rgb), 0.04);
}

.ed-status-hero.is-warning {
  border-color: rgba(var(--color-warning-rgb), 0.3);
  background: rgba(var(--color-warning-rgb), 0.04);
}

.ed-status-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ed-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ed-status-dot.is-running {
  background: var(--color-brand-accent-light);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.2);
  animation: ed-pulse 2s ease-in-out infinite;
}

.ed-status-dot.is-success {
  background: var(--color-success);
  box-shadow: 0 0 0 3px rgba(var(--color-success-rgb), 0.2);
}

.ed-status-dot.is-error {
  background: var(--color-error);
  box-shadow: 0 0 0 3px rgba(var(--color-error-rgb), 0.2);
}

.ed-status-dot.is-warning {
  background: var(--color-warning);
  box-shadow: 0 0 0 3px rgba(var(--color-warning-rgb), 0.2);
}

@keyframes ed-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.ed-status-label {
  font-size: var(--font-size-sm);
  font-weight: 700;
  color: var(--color-text-primary);
}

.ed-status-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ed-meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  white-space: nowrap;
}

/* ===== Section ===== */
.ed-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ed-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ===== KV Grid (Observability) ===== */
.ed-kv-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.ed-kv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--color-border);
  transition: background var(--transition-fast);
}

.ed-kv-item:last-child {
  border-bottom: none;
}

.ed-kv-item:hover {
  background: var(--color-hover-overlay);
}

.ed-kv-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.ed-kv-value {
  font-size: 12px;
  color: var(--color-text-primary);
  text-align: right;
  word-break: break-all;
  font-family: var(--font-mono);
  background: none;
  border: none;
  padding: 0;
}

.ed-kv-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ed-copy-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: all var(--transition-fast);
}

.ed-kv-item:hover .ed-copy-btn {
  opacity: 1;
}

.ed-copy-btn:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.ed-copy-btn.is-copied {
  opacity: 1;
  color: var(--color-success);
}

/* ===== Runtime Grid ===== */
.ed-runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.ed-runtime-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  transition: border-color var(--transition-fast);
}

.ed-runtime-card:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.25);
}

.ed-runtime-label {
  font-size: 11px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ed-runtime-value {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

/* ===== Badge ===== */
.ed-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.ed-badge--running {
  color: var(--color-brand-accent-light);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  border-color: rgba(var(--color-brand-accent-rgb), 0.3);
}

.ed-badge--success {
  color: var(--color-success);
  background: rgba(var(--color-success-rgb), 0.1);
  border-color: rgba(var(--color-success-rgb), 0.3);
}

.ed-badge--error {
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.1);
  border-color: rgba(var(--color-error-rgb), 0.3);
}

.ed-badge--warning {
  color: var(--color-warning);
  background: rgba(var(--color-warning-rgb), 0.1);
  border-color: rgba(var(--color-warning-rgb), 0.3);
}

/* ===== Bool indicator dot ===== */
.ed-bool-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}

.ed-bool-dot.is-alive {
  background: var(--color-success);
  box-shadow: 0 0 0 2px rgba(var(--color-success-rgb), 0.2);
}

.ed-bool-dot.is-dead {
  background: var(--color-error);
  box-shadow: 0 0 0 2px rgba(var(--color-error-rgb), 0.2);
}

/* ===== Transition ===== */
.exec-drawer-fade-enter-active,
.exec-drawer-fade-leave-active {
  transition: opacity 0.25s ease;
}

.exec-drawer-fade-enter-active .ed-drawer,
.exec-drawer-fade-leave-active .ed-drawer {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.exec-drawer-fade-enter-from,
.exec-drawer-fade-leave-to {
  opacity: 0;
}

.exec-drawer-fade-enter-from .ed-drawer {
  transform: translateX(100%);
}

.exec-drawer-fade-leave-to .ed-drawer {
  transform: translateX(100%);
}

/* ===== Responsive ===== */
@media (max-width: 600px) {
  .ed-drawer {
    width: 100vw;
  }

  .ed-runtime-grid {
    grid-template-columns: 1fr;
  }

  .ed-status-hero {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

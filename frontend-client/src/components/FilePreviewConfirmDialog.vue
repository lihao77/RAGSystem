<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible" class="fp-overlay" @click.stop>
        <div class="fp-container">
          <div class="fp-header">
            <div class="fp-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <div class="fp-header-text">
              <h3 class="fp-title">文件预览确认</h3>
              <span class="fp-subtitle">{{ filePath }}</span>
            </div>
          </div>

          <div class="fp-body">
            <div class="fp-meta-row">
              <div class="fp-meta-item">
                <span class="fp-meta-label">文件大小</span>
                <span class="fp-meta-value">{{ formattedSize }}</span>
              </div>
              <div class="fp-meta-item">
                <span class="fp-meta-label">状态</span>
                <span class="fp-meta-value fp-meta-warn">超出预览阈值 (5KB)</span>
              </div>
            </div>

            <div class="fp-preview-box">
              <div class="fp-preview-label">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="16 18 22 12 16 6"/>
                  <polyline points="8 6 2 12 8 18"/>
                </svg>
                前 5KB 预览
              </div>
              <pre class="fp-preview-content">{{ preview }}</pre>
            </div>
          </div>

          <div class="fp-footer">
            <button class="fp-btn fp-btn-preview" @click="handleDeny">
              仅使用预览
            </button>
            <button class="fp-btn fp-btn-full" @click="handleApprove">
              读取完整内容
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';

const visible = ref(false);
const filePath = ref('');
const fileSize = ref(0);
const preview = ref('');

let _approvalId = '';
let _onApprove = null;
let _onDeny = null;

const formattedSize = computed(() => {
  const s = fileSize.value;
  if (s < 1024) return `${s} B`;
  if (s < 1024 * 1024) return `${(s / 1024).toFixed(1)} KB`;
  return `${(s / (1024 * 1024)).toFixed(1)} MB`;
});

const show = (data, onApprove, onDeny) => {
  _approvalId = data.approval_id || '';
  filePath.value = data.file_path || '';
  fileSize.value = data.file_size || 0;
  preview.value = data.preview || '';
  _onApprove = onApprove || null;
  _onDeny = onDeny || null;
  visible.value = true;
};

const hide = () => {
  visible.value = false;
};

const handleApprove = () => {
  hide();
  if (_onApprove) _onApprove(_approvalId, '');
};

const handleDeny = () => {
  hide();
  if (_onDeny) _onDeny(_approvalId, '');
};

defineExpose({ show, hide });
</script>

<style scoped>
.fp-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-dialog);
  padding: var(--spacing-md);
  animation: fpOverlayIn 0.2s ease;
}

@keyframes fpOverlayIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.fp-container {
  background: var(--color-bg-primary);
  border: 2px solid var(--color-accent);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
  max-width: 640px;
  width: 100%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  animation: fpSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes fpSlideIn {
  from { transform: scale(0.9) translateY(-20px); opacity: 0; }
  to   { transform: scale(1) translateY(0); opacity: 1; }
}

.fp-header {
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  background: linear-gradient(135deg, rgba(var(--color-accent-rgb, 99, 102, 241), 0.1) 0%, transparent 100%);
  flex-shrink: 0;
}

.fp-icon {
  width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--color-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-bg-primary);
  flex-shrink: 0;
}

.fp-header-text {
  min-width: 0;
}

.fp-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.fp-subtitle {
  display: block;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  font-family: 'Courier New', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-body {
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.fp-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.fp-meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  flex: 1;
  min-width: 0;
}

.fp-meta-label {
  color: var(--color-text-secondary);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.fp-meta-value {
  color: var(--color-text-primary);
  font-weight: 600;
}

.fp-meta-warn {
  color: var(--color-warning);
}

.fp-preview-box {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.fp-preview-label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: var(--color-bg-secondary);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fp-preview-content {
  margin: 0;
  padding: 10px 12px;
  font-family: 'Courier New', monospace;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  background: transparent;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 360px;
  overflow-y: auto;
}

.fp-footer {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

.fp-btn {
  flex: 1;
  padding: 12px 20px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  border: none;
  outline: none;
}

.fp-btn-preview {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
}

.fp-btn-preview:hover {
  background: var(--color-bg-tertiary, var(--color-bg-secondary));
  transform: translateY(-1px);
}

.fp-btn-full {
  background: var(--color-accent);
  color: #fff;
}

.fp-btn-full:hover {
  box-shadow: 0 0 16px rgba(var(--color-accent-rgb, 99, 102, 241), 0.5);
  transform: translateY(-1px);
}

.fp-btn:active {
  transform: scale(0.98);
}

.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

@media (max-width: 767px) {
  .fp-container {
    max-width: calc(100vw - 32px);
  }
  .fp-header, .fp-body {
    padding: var(--spacing-md);
  }
  .fp-footer {
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
    flex-direction: column;
  }
}
</style>

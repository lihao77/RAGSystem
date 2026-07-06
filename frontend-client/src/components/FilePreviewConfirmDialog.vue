<template>
  <Dialog :open="visible" @update:open="(v) => { if (!v) handleDeny() }">
    <DialogContent class="max-w-[640px] gap-0 p-0 overflow-hidden">
      <div class="fp-header">
        <div class="fp-icon">
          <IconFile :size="22" />
        </div>
        <div class="fp-header-text">
          <DialogTitle>文件预览确认</DialogTitle>
          <DialogDescription class="fp-subtitle">{{ filePath }}</DialogDescription>
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
            <span class="fp-meta-value fp-meta-warn">超出预览阈值 ({{ formattedThreshold }})</span>
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
            前 {{ formattedThreshold }} 预览
          </div>
          <pre class="fp-preview-content">{{ preview }}</pre>
        </div>
      </div>

      <DialogFooter class="fp-footer">
        <Button class="w-full" variant="ghost" @click="handleDeny">
          仅使用预览
        </Button>
        <Button class="w-full" variant="default" @click="handleApprove">
          读取完整内容
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { ref, computed } from 'vue';
import IconFile from './icons/IconFile.vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

const visible = ref(false);
const filePath = ref('');
const fileSize = ref(0);
const preview = ref('');
const previewThreshold = ref(32 * 1024);

let _approvalId = '';
let _onApprove = null;
let _onDeny = null;

const formatSize = (s) => {
  if (s < 1024) return `${s} B`;
  if (s < 1024 * 1024) {
    const value = s / 1024;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} KB`;
  }
  const value = s / (1024 * 1024);
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} MB`;
};

const formattedSize = computed(() => formatSize(fileSize.value));
const formattedThreshold = computed(() => formatSize(previewThreshold.value));

const show = (data, onApprove, onDeny) => {
  _approvalId = data.approval_id || '';
  filePath.value = data.file_path || '';
  fileSize.value = data.file_size || 0;
  preview.value = data.preview || '';
  previewThreshold.value = data.preview_threshold || 32 * 1024;
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

.fp-subtitle {
  display: block;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
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
  font-family: var(--font-mono);
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
  flex-shrink: 0;
}

@media (max-width: 767px) {
  .fp-header, .fp-body {
    padding: var(--spacing-md);
  }
  .fp-footer {
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
    flex-direction: column;
  }
}
</style>

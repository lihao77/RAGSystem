<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <div v-if="visible" class="ctx-drawer-overlay" @click="$emit('close')">
        <div class="ctx-drawer" @click.stop>
          <div class="ctx-drawer-header">
            <div>
              <h3>会话文件</h3>
              <div class="ctx-subtitle">{{ sessionId ? `${files.length} 个文件` : '上传文件将自动创建会话' }}</div>
            </div>
            <button class="ctx-close-btn" @click="$emit('close')">&times;</button>
          </div>

          <div class="ctx-drawer-body">
            <section class="ctx-section">
              <div class="ctx-actions-row">
                <input ref="fileInputRef" type="file" multiple style="display:none" @change="onFileChange" />
                <button class="ctx-action-btn ctx-action-btn--primary" :disabled="uploading" @click="fileInputRef?.click()">
                  <span class="ctx-action-btn__icon">+</span>
                  <span>{{ uploading ? '上传中...' : '上传文件' }}</span>
                </button>
                <button v-if="sessionId" class="ctx-action-btn ctx-action-btn--ghost" :disabled="loading" @click="$emit('refresh')">
                  <span class="ctx-action-btn__icon">↻</span>
                  <span>刷新</span>
                </button>
              </div>
            </section>

            <div v-if="loading" class="ctx-loading">加载文件中...</div>
            <div v-else-if="!files.length" class="ctx-empty-state">
              <div class="ctx-empty-title">暂无会话文件</div>
              <div class="ctx-empty-desc">{{ sessionId ? '你可以上传文件，让当前会话直接使用。' : '上传文件后会自动创建一个新的会话。' }}</div>
            </div>
            <section v-else class="ctx-section">
              <div class="ctx-file-list">
                <div v-for="file in files" :key="file.id" class="ctx-file-item">
                  <div class="ctx-file-main">
                    <div class="ctx-file-name" :title="file.original_name || file.stored_name">{{ file.original_name || file.stored_name }}</div>
                    <div class="ctx-file-meta">
                      <span>{{ formatSize(file.size) }}</span>
                      <span v-if="file.mime">{{ file.mime }}</span>
                    </div>
                  </div>
                  <div class="ctx-file-actions">
                    <button class="ctx-inline-btn" @click="$emit('download', file)">下载</button>
                    <button class="ctx-inline-btn ctx-inline-btn--danger" :disabled="deletingFileId === file.id" @click="$emit('delete', file)">
                      {{ deletingFileId === file.id ? '删除中...' : '删除' }}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue';

defineProps({
  visible: Boolean,
  sessionId: { type: String, default: '' },
  files: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  uploading: { type: Boolean, default: false },
  deletingFileId: { type: String, default: '' },
});

const emit = defineEmits(['close', 'upload', 'delete', 'download', 'refresh']);
const fileInputRef = ref(null);

const onFileChange = (event) => {
  const files = event.target.files;
  if (files?.length) emit('upload', files);
  if (fileInputRef.value) fileInputRef.value.value = '';
};

const formatSize = (size) => {
  const num = Number(size || 0);
  if (!num) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
};
</script>

<style scoped>
/* ── overlay ── */
.ctx-drawer-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.5);
  z-index: var(--z-modal);
  display: flex; justify-content: flex-end;
}

/* ── panel ── */
.ctx-drawer {
  width: min(480px, 90vw); height: 100%;
  background: var(--color-bg-primary);
  display: flex; flex-direction: column;
  border-left: 1px solid var(--color-border);
  box-shadow: -4px 0 32px rgba(0,0,0,.2);
}

/* ── header ── */
.ctx-drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.ctx-drawer-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--color-text-primary); }
.ctx-subtitle { margin-top: 3px; font-size: 12px; color: var(--color-text-muted); }
.ctx-close-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: var(--radius-sm);
  font-size: 18px; line-height: 1; cursor: pointer;
  color: var(--color-text-secondary);
  transition: all var(--transition-fast);
}
.ctx-close-btn:hover { background: var(--color-bg-secondary); color: var(--color-text-primary); }

/* ── body ── */
.ctx-drawer-body { flex: 1; overflow-y: auto; padding: 12px; }
.ctx-section { margin-bottom: 16px; }

/* ── action buttons（与 sidebar-btn 同语言）── */
.ctx-actions-row { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 8px; }
.ctx-action-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-secondary);
  font-size: 13px; font-weight: 500;
  cursor: pointer; white-space: nowrap;
  transition: all var(--transition-fast);
}
.ctx-action-btn:hover:not(:disabled) {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
  color: var(--color-text-primary);
}
.ctx-action-btn--primary {
  background: var(--color-brand-accent);
  border-color: var(--color-brand-accent);
  color: #fff;
}
.ctx-action-btn--primary:hover:not(:disabled) { opacity: 0.85; }
.ctx-action-btn--ghost {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text-secondary);
}
.ctx-action-btn--ghost:hover:not(:disabled) {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}
.ctx-action-btn__icon { font-size: 14px; line-height: 1; }
.ctx-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── loading / empty ── */
.ctx-loading { padding: 48px 20px; text-align: center; font-size: 13px; color: var(--color-text-muted); }
.ctx-empty-state { padding: 48px 20px; text-align: center; }
.ctx-empty-title { font-size: 13px; font-weight: 600; color: var(--color-text-secondary); }
.ctx-empty-desc { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--color-text-muted); }

/* ── file list（平铺风格，与 history-item 对齐）── */
.ctx-file-list { display: flex; flex-direction: column; }
.ctx-file-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px var(--spacing-sm);
  margin: 0 var(--spacing-sm) 2px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  transition: all var(--transition-fast);
  position: relative;
}
.ctx-file-item:hover {
  background: var(--color-bg-secondary);
  border-color: var(--color-border);
}
.ctx-file-main { min-width: 0; flex: 1; }
.ctx-file-name {
  font-size: 13px; font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ctx-file-meta {
  display: flex; gap: 8px; margin-top: 2px;
  font-size: 11px; color: var(--color-text-muted);
}

/* ── 行内操作按钮（hover 时淡入）── */
.ctx-file-actions {
  display: flex; gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.ctx-file-item:hover .ctx-file-actions { opacity: 1; }
.ctx-inline-btn {
  height: 26px; padding: 0 8px;
  display: flex; align-items: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px; font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.ctx-inline-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border);
  color: var(--color-text-primary);
}
.ctx-inline-btn--danger:hover {
  background: rgba(var(--color-error-rgb), 0.08);
  border-color: transparent;
  color: var(--color-error);
}
.ctx-inline-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── 过渡动画 ── */
.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity .2s; }
.drawer-fade-enter-active .ctx-drawer, .drawer-fade-leave-active .ctx-drawer {
  transition: transform .2s cubic-bezier(0.4, 0, 0.2, 1);
}
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
.drawer-fade-enter-from .ctx-drawer, .drawer-fade-leave-to .ctx-drawer { transform: translateX(100%); }
</style>

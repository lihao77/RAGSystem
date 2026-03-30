<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <div v-if="visible" class="ctx-drawer-overlay" @click="$emit('close')">
        <div class="ctx-drawer ctx-drawer--dialog" @click.stop>
          <div class="ctx-drawer-header">
            <div>
              <h3>{{ mode === 'message-edit' ? '编辑消息附件' : '添加附件' }}</h3>
              <div class="ctx-subtitle">{{ subtitleText }}</div>
            </div>
            <button class="ctx-close-btn" @click="$emit('close')">&times;</button>
          </div>

          <div class="ctx-drawer-body">
            <section class="ctx-section">
              <div class="ctx-actions-row">
                <input ref="fileInputRef" type="file" multiple style="display:none" @change="onFileChange" />
                <button class="ctx-action-btn ctx-action-btn--primary" :disabled="uploading" @click="fileInputRef?.click()">
                  <span class="ctx-action-btn__icon">+</span>
                  <span>{{ uploading ? '上传中...' : '选择图片或文件' }}</span>
                </button>
                <button v-if="sessionId" class="ctx-action-btn ctx-action-btn--ghost" :disabled="loading" @click="$emit('refresh')">
                  <span class="ctx-action-btn__icon">↻</span>
                  <span>刷新会话文件</span>
                </button>
              </div>
            </section>

            <div v-if="uploading" class="ctx-loading">正在上传附件...</div>
            <section v-if="pendingFiles.length" class="ctx-section">
              <div class="ctx-section-title">{{ pendingTitle }}</div>
              <div class="ctx-file-list">
                <div v-for="file in pendingFiles" :key="file.file_id || file.id" class="ctx-file-item ctx-file-item--pending">
                  <div class="ctx-file-main">
                    <div class="ctx-file-name" :title="file.original_name || file.stored_name">{{ file.original_name || file.stored_name }}</div>
                    <div class="ctx-file-meta">
                      <span>{{ formatSize(file.size) }}</span>
                      <span v-if="file.mime">{{ file.mime }}</span>
                      <span>{{ isImage(file) ? '图片' : '文件' }}</span>
                    </div>
                  </div>
                  <div class="ctx-file-actions ctx-file-actions--visible">
                    <button class="ctx-inline-btn ctx-inline-btn--danger" @click="$emit('removePending', file)">移除</button>
                  </div>
                </div>
              </div>
            </section>

            <div v-if="loading" class="ctx-loading">加载文件中...</div>
            <section v-else-if="files.length" class="ctx-section">
              <div class="ctx-section-title">当前会话文件</div>
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
                    <button class="ctx-inline-btn" @click="$emit('reuse', file)">{{ reuseButtonText }}</button>
                    <button class="ctx-inline-btn ctx-inline-btn--danger" :disabled="deletingFileId === file.id" @click="$emit('delete', file)">
                      {{ deletingFileId === file.id ? '删除中...' : '删除' }}
                    </button>
                  </div>
                </div>
              </div>
            </section>
            <div v-else class="ctx-empty-state">
              <div class="ctx-empty-title">还没有附件</div>
              <div class="ctx-empty-desc">{{ emptyDesc }}</div>
            </div>
          </div>

          <div class="ctx-dialog-footer">
            <button class="ctx-action-btn ctx-action-btn--ghost" @click="$emit('close')">关闭</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  visible: Boolean,
  mode: { type: String, default: 'composer' },
  sessionId: { type: String, default: '' },
  files: { type: Array, default: () => [] },
  pendingFiles: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  uploading: { type: Boolean, default: false },
  deletingFileId: { type: String, default: '' },
});

const emit = defineEmits(['close', 'upload', 'delete', 'download', 'refresh', 'reuse', 'removePending']);
const fileInputRef = ref(null);

const subtitleText = computed(() => {
  if (!props.sessionId) return '上传附件将自动创建会话';
  return props.mode === 'message-edit'
    ? '上传或复用会话文件到当前编辑中的消息'
    : '上传后将附加到本轮消息';
});

const pendingTitle = computed(() => (
  props.mode === 'message-edit' ? '当前编辑消息附件' : '本轮待发送'
));

const reuseButtonText = computed(() => (
  props.mode === 'message-edit' ? '附加到当前消息' : '附加到本轮'
));

const emptyDesc = computed(() => (
  props.mode === 'message-edit'
    ? '上传图片或文件后，它会附加到当前正在编辑的这条消息。'
    : '上传图片或文件后，它会附加到你接下来发送的这条消息。'
));

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

const isImage = (file) => String(file?.mime || '').startsWith('image/');
</script>

<style scoped>
.ctx-drawer-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.55);
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.ctx-drawer {
  width: min(720px, 96vw);
  max-height: 88vh;
  background: var(--color-bg-primary);
  display: flex; flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 20px;
  box-shadow: 0 24px 80px rgba(0,0,0,.28);
}

.ctx-drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.ctx-drawer-header h3 { margin: 0; font-size: 16px; font-weight: 600; color: var(--color-text-primary); }
.ctx-subtitle { margin-top: 3px; font-size: 12px; color: var(--color-text-muted); }
.ctx-close-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: var(--radius-sm);
  font-size: 18px; line-height: 1; cursor: pointer;
  color: var(--color-text-secondary);
  transition: all 0.2s;
}
.ctx-close-btn:hover { background: var(--color-bg-secondary); color: var(--color-text-primary); }

.ctx-drawer-body { flex: 1; overflow-y: auto; padding: 16px; }
.ctx-section { margin-bottom: 18px; }
.ctx-section-title {
  margin: 0 8px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ctx-actions-row { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 8px; }
.ctx-action-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 36px; padding: 0 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-secondary);
  font-size: 13px; font-weight: 500;
  cursor: pointer; white-space: nowrap;
  transition: all 0.2s;
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
.ctx-action-btn--primary:hover:not(:disabled) { opacity: 0.88; }
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

.ctx-loading { padding: 36px 20px; text-align: center; font-size: 13px; color: var(--color-text-muted); }
.ctx-empty-state { padding: 36px 20px; text-align: center; }
.ctx-empty-title { font-size: 13px; font-weight: 600; color: var(--color-text-secondary); }
.ctx-empty-desc { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--color-text-muted); }

.ctx-file-list { display: flex; flex-direction: column; }
.ctx-file-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px var(--spacing-sm);
  margin: 0 var(--spacing-sm) 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  transition: all 0.2s;
  position: relative;
}
.ctx-file-item--pending {
  background: rgba(var(--color-brand-accent-rgb, 99, 102, 241), 0.08);
  border-color: rgba(var(--color-brand-accent-rgb, 99, 102, 241), 0.24);
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
  flex-wrap: wrap;
}

.ctx-file-actions {
  display: flex; gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}
.ctx-file-item:hover .ctx-file-actions { opacity: 1; }
.ctx-file-actions--visible { opacity: 1; }
.ctx-inline-btn {
  height: 28px; padding: 0 8px;
  display: flex; align-items: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px; font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
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

.ctx-dialog-footer {
  display: flex;
  justify-content: flex-end;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
}

.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity .2s; }
.drawer-fade-enter-active .ctx-drawer, .drawer-fade-leave-active .ctx-drawer {
  transition: transform .2s cubic-bezier(0.4, 0, 0.2, 1);
}
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
.drawer-fade-enter-from .ctx-drawer, .drawer-fade-leave-to .ctx-drawer { transform: translateY(16px) scale(0.98); }
</style>

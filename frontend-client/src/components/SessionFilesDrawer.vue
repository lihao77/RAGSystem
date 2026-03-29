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
.ctx-drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: var(--z-modal); display: flex; justify-content: flex-end; }
.ctx-drawer { width: min(520px, 90vw); height: 100%; background: var(--color-bg-primary, #fff); display: flex; flex-direction: column; box-shadow: -2px 0 12px rgba(0,0,0,.15); }
.ctx-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--color-border, #e4e7ed); }
.ctx-drawer-header h3 { margin: 0; font-size: 15px; }
.ctx-subtitle { margin-top: 4px; font-size: 12px; color: var(--color-text-muted, #999); }
.ctx-close-btn { background: none; border: none; font-size: 22px; cursor: pointer; color: var(--color-text-secondary, #666); line-height: 1; }
.ctx-drawer-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.ctx-loading { padding: 40px; text-align: center; color: var(--color-text-muted, #999); }
.ctx-section { margin-bottom: 18px; }
.ctx-actions-row { display: flex; gap: 10px; flex-wrap: wrap; }
.ctx-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all var(--transition-fast, 0.2s ease);
  user-select: none;
  white-space: nowrap;
}
.ctx-action-btn:hover:not(:disabled) {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover, var(--color-border));
}
.ctx-action-btn--primary {
  background: var(--color-brand-accent);
  border-color: var(--color-brand-accent);
  color: #fff;
}
.ctx-action-btn--primary:hover:not(:disabled) {
  background: var(--color-brand-accent-light);
  border-color: var(--color-brand-accent-light);
}
.ctx-action-btn--ghost {
  background: transparent;
  border-color: var(--color-glass-border, var(--color-border));
  color: var(--color-text-secondary, #666);
}
.ctx-action-btn--ghost:hover:not(:disabled) {
  background: var(--color-hover-overlay, rgba(255,255,255,0.06));
  color: var(--color-text-primary, #333);
}
.ctx-action-btn__icon {
  font-size: 14px;
  line-height: 1;
  opacity: 0.9;
}
.ctx-action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ctx-empty-state {
  padding: 40px 18px;
  text-align: center;
  color: var(--color-text-muted, #999);
}
.ctx-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-secondary, #666);
}
.ctx-empty-desc {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.ctx-file-list { display: flex; flex-direction: column; gap: 10px; }
.ctx-file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-secondary, #f9f9f9);
  border: 1px solid var(--color-border-light, #ebeef5);
}
.ctx-file-main { min-width: 0; flex: 1; }
.ctx-file-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary, #333);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-file-meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-muted, #999);
  flex-wrap: wrap;
}
.ctx-file-actions { display: flex; gap: 8px; }
.ctx-inline-btn {
  background: transparent;
  border: none;
  color: var(--color-active, #409eff);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.ctx-inline-btn--danger { color: var(--color-error, #f56c6c); }
.ctx-inline-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity .25s; }
.drawer-fade-enter-active .ctx-drawer, .drawer-fade-leave-active .ctx-drawer { transition: transform .25s; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
.drawer-fade-enter-from .ctx-drawer { transform: translateX(100%); }
.drawer-fade-leave-to .ctx-drawer { transform: translateX(100%); }
</style>

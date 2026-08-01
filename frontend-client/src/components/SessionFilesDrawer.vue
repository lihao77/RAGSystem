<template>
  <Dialog :open="visible" @update:open="onOpenChange">
    <DialogContent class="flex max-h-[88vh] w-full max-w-[720px] flex-col gap-0 overflow-hidden p-0" :hide-close="true">
      <div class="ctx-drawer-header">
        <div>
          <DialogTitle class="ctx-drawer-title">{{ mode === 'message-edit' ? '编辑消息附件' : '添加附件' }}</DialogTitle>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="关闭" @click="emit('close')">
          <IconClose :size="16" />
        </Button>
      </div>

      <div class="ctx-drawer-body">
        <section class="ctx-section">
          <div class="ctx-actions-row">
            <input ref="fileInputRef" type="file" multiple style="display:none" @change="onFileChange" />
            <Button variant="default" :disabled="uploading" @click="fileInputRef?.click()">
              <IconPlus :size="15" />
              <span>{{ uploading ? '处理中...' : '选择图片或文件' }}</span>
            </Button>
            <Button v-if="sessionId" variant="ghost" :disabled="loading" @click="emit('refresh')">
              <IconRefresh :size="14" />
              <span>刷新会话文件</span>
            </Button>
          </div>
          <div class="ctx-dropzone-hint">
            也可拖拽文件到窗口添加
          </div>
        </section>

        <div v-if="uploading" class="ctx-loading"><span class="g-spinner g-spinner--sm"></span>正在准备发送附件...</div>
        <section v-if="pendingFiles.length" class="ctx-section">
          <div class="ctx-section-title">{{ pendingTitle }}</div>
          <div class="ctx-file-list">
            <div v-for="file in pendingFiles" :key="file.local_id || file.file_id || file.id" class="ctx-file-item ctx-file-item--pending">
              <div class="ctx-file-main">
                <button v-if="isImageAttachment(file)" class="ctx-thumb-btn" @click="openImages(pendingFiles, file)"><AuthenticatedImage :src="getPreviewUrl(file)" :alt="file.original_name || file.stored_name" class="ctx-thumb" /></button>
                <div class="ctx-file-name" :title="file.original_name || file.stored_name">{{ file.original_name || file.stored_name }}</div>
                <div class="ctx-file-meta">
                  <span>{{ formatAttachmentSize(file.size) }}</span>
                  <span v-if="file.mime">{{ file.mime }}</span>
                  <span>{{ isImageAttachment(file) ? '图片' : '文件' }}</span>
                </div>
              </div>
              <div class="ctx-file-actions ctx-file-actions--visible">
                <Button variant="action-danger" size="action" @click="emit('removePending', file)">移除</Button>
              </div>
            </div>
          </div>
        </section>

        <div v-if="loading" class="ctx-loading"><span class="g-spinner g-spinner--sm"></span>加载文件中...</div>
        <section v-else-if="files.length" class="ctx-section">
          <div class="ctx-section-title">当前会话文件</div>
          <div class="ctx-file-list">
            <div v-for="file in files" :key="file.id" class="ctx-file-item">
              <div class="ctx-file-main">
                <div class="ctx-file-name" :title="file.original_name || file.stored_name">{{ file.original_name || file.stored_name }}</div>
                <div class="ctx-file-meta">
                  <span>{{ formatAttachmentSize(file.size) }}</span>
                  <span v-if="file.mime">{{ file.mime }}</span>
                </div>
              </div>
              <div class="ctx-file-actions">
                <Button variant="action-neutral" size="action" @click="emit('download', file)">下载</Button>
                <Button variant="action-neutral" size="action" @click="emit('reuse', file)">{{ reuseButtonText }}</Button>
                <Button variant="action-danger" size="action" :disabled="deletingFileId === file.id" @click="emit('delete', file)">
                  {{ deletingFileId === file.id ? '删除中...' : '删除' }}
                </Button>
              </div>
            </div>
          </div>
        </section>
        <EmptyState v-else-if="!pendingFiles.length" title="还没有附件" :hint="emptyDesc" />
      </div>
    </DialogContent>
  </Dialog>
  <ImageLightbox :open="lightbox.open.value" :images="lightbox.images.value" :index="lightbox.index.value" :current="lightbox.current.value" @close="lightbox.close" @previous="lightbox.previous" @next="lightbox.next" />
</template>

<script setup>
import { computed, ref } from 'vue';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import EmptyState from './EmptyState.vue';
import { formatAttachmentSize, getSessionFileDownloadUrl, isImageAttachment, isLocalAttachment } from '../utils/sessionAttachments';
import IconPlus from './icons/IconPlus.vue';
import IconClose from './icons/IconClose.vue';
import IconRefresh from './icons/IconRefresh.vue';
import { Button } from './ui/button';
import ImageLightbox from './common/ImageLightbox.vue';
import AuthenticatedImage from './common/AuthenticatedImage.vue';
import { useImageLightbox } from '../composables/useImageLightbox.js';

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
const lightbox = useImageLightbox();
const getPreviewUrl = (file) => {
  if (isLocalAttachment(file)) return file.preview_url || '';
  const fileId = file.file_id || file.id;
  return props.sessionId && fileId ? getSessionFileDownloadUrl(props.sessionId, fileId) : '';
};
const openImages = (items, selected) => { const images = items.filter(isImageAttachment).map(file => ({ src: getPreviewUrl(file), alt: file.original_name || file.stored_name || '图片', source: file })); lightbox.show(images, Math.max(0, images.findIndex(item => item.source === selected))); };

function onOpenChange(open) {
  if (!open) emit('close');
}

const pendingTitle = computed(() => (
  props.mode === 'message-edit' ? '当前编辑草稿附件' : '本轮待发送附件'
));

const reuseButtonText = computed(() => (
  props.mode === 'message-edit' ? '附加到当前消息' : '附加到本轮'
));

const emptyDesc = computed(() => (
  props.mode === 'message-edit'
    ? '选择图片或文件后，它会先加入当前编辑草稿，并在确认重发时上传。'
    : '选择图片或文件后，它会先加入待发送附件，并在你点击发送时上传。'
));

const onFileChange = (event) => {
  const files = event.target.files;
  if (files?.length) emit('upload', files);
  if (fileInputRef.value) fileInputRef.value.value = '';
};
</script>

<style scoped>
.ctx-drawer-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.ctx-drawer-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--color-text-primary); }
.ctx-subtitle { margin-top: 3px; font-size: 12px; color: var(--color-text-muted); }

.ctx-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
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
.ctx-dropzone-hint {
  margin: 10px 8px 0;
  padding: 10px 12px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
  transition: all 0.2s ease;
}

.ctx-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 36px 20px; font-size: 13px; color: var(--color-text-muted); }

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
  background: rgba(var(--color-brand-accent-rgb), 0.08);
  border-color: rgba(var(--color-brand-accent-rgb), 0.24);
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
.ctx-file-item:hover .ctx-file-actions,
.ctx-file-item:focus-within .ctx-file-actions { opacity: 1; }
.ctx-file-actions--visible { opacity: 1; }
@media (hover: none) {
  .ctx-file-actions { opacity: 1; }
}

.ctx-thumb-btn {
  display: block;
  margin-bottom: 8px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}
.ctx-thumb {
  width: 100%;
  max-width: 220px;
  height: 128px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.ctx-thumb:hover {
  transform: scale(1.02);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
}

</style>

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
          <input ref="fileInputRef" type="file" multiple style="display:none" @change="onFileChange" />
          <button type="button" class="ctx-dropzone" :disabled="uploading" @click="fileInputRef?.click()">
            <span class="ctx-dropzone-icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </span>
            <span class="ctx-dropzone-title">{{ uploading ? '处理中...' : '点击选择图片或文件' }}</span>
            <span class="ctx-dropzone-sub">支持多选，也可直接拖拽文件到窗口任意位置</span>
          </button>
          <div v-if="sessionId" class="ctx-toolbar">
            <Button variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">
              <IconRefresh :size="14" />
              <span>刷新会话文件</span>
            </Button>
          </div>
        </section>

        <div v-if="uploading" class="ctx-loading"><span class="g-spinner g-spinner--sm"></span>正在准备发送附件...</div>
        <section v-if="pendingFiles.length" class="ctx-section">
          <div class="ctx-section-title">{{ pendingTitle }}</div>
          <div class="ctx-file-list">
            <div v-for="file in pendingFiles" :key="file.local_id || file.file_id || file.id" class="ctx-file-item ctx-file-item--pending">
              <button
                v-if="isImageAttachment(file) && getPreviewUrl(file)"
                type="button"
                class="ctx-file-thumb-btn"
                title="预览图片"
                @click="openImages(pendingFiles, file)"
              >
                <AuthenticatedImage :src="getPreviewUrl(file)" :alt="file.original_name || file.stored_name" class="ctx-file-thumb" />
              </button>
              <div v-else class="ctx-file-icon"><IconFile :size="18" /></div>
              <div class="ctx-file-main">
                <div class="ctx-file-name" :title="file.original_name || file.stored_name">{{ file.original_name || file.stored_name }}</div>
                <div class="ctx-file-meta">
                  <span>{{ formatAttachmentSize(file.size) }}</span>
                  <span class="ctx-file-kind">{{ isImageAttachment(file) ? '图片' : '文件' }}</span>
                </div>
              </div>
              <div class="ctx-file-actions ctx-file-actions--visible">
                <Button variant="ghost" size="icon-sm" title="移除" aria-label="移除" @click="emit('removePending', file)"><IconClose :size="14" /></Button>
              </div>
            </div>
          </div>
        </section>

        <div v-if="loading" class="ctx-loading"><span class="g-spinner g-spinner--sm"></span>加载文件中...</div>
        <section v-else-if="files.length" class="ctx-section">
          <div class="ctx-section-title">当前会话文件</div>
          <div class="ctx-file-list">
            <div v-for="file in files" :key="file.id" class="ctx-file-item">
              <button
                v-if="isImageAttachment(file) && getPreviewUrl(file)"
                type="button"
                class="ctx-file-thumb-btn"
                title="预览图片"
                @click="openImages(files, file)"
              >
                <AuthenticatedImage :src="getPreviewUrl(file)" :alt="file.original_name || file.stored_name" class="ctx-file-thumb" />
              </button>
              <div v-else class="ctx-file-icon"><IconFile :size="18" /></div>
              <div class="ctx-file-main">
                <div class="ctx-file-name" :title="file.original_name || file.stored_name">{{ file.original_name || file.stored_name }}</div>
                <div class="ctx-file-meta">
                  <span>{{ formatAttachmentSize(file.size) }}</span>
                  <span v-if="file.mime">{{ file.mime }}</span>
                </div>
              </div>
              <div class="ctx-file-actions">
                <Button variant="ghost" size="icon-sm" title="下载" aria-label="下载" @click="emit('download', file)"><IconDownload :size="15" /></Button>
                <Button variant="ghost" size="icon-sm" :title="reuseButtonText" :aria-label="reuseButtonText" @click="emit('reuse', file)"><IconPlus :size="15" /></Button>
                <Button variant="ghost" size="icon-sm" class="ctx-action-danger" title="删除" aria-label="删除" :disabled="deletingFileId === file.id" @click="emit('delete', file)">
                  <span v-if="deletingFileId === file.id" class="g-spinner g-spinner--sm"></span>
                  <IconTrash v-else :size="15" />
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
import IconFile from './icons/IconFile.vue';
import IconClose from './icons/IconClose.vue';
import IconPlus from './icons/IconPlus.vue';
import IconTrash from './icons/IconTrash.vue';
import IconDownload from './icons/IconDownload.vue';
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
.ctx-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 22px 16px;
  border: 1.5px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: border-color 0.2s ease, background 0.2s ease;
}
.ctx-dropzone:hover:not(:disabled) {
  border-color: rgba(var(--color-brand-accent-rgb), 0.5);
  background: rgba(var(--color-brand-accent-rgb), 0.05);
}
.ctx-dropzone:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ctx-dropzone-icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  color: var(--color-brand-accent);
}
.ctx-dropzone-icon svg {
  width: 16px;
  height: 16px;
}
.ctx-dropzone-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.ctx-dropzone-sub {
  font-size: 11px;
  color: var(--color-text-muted);
}
.ctx-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
  padding: 0 8px;
}

.ctx-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 36px 20px; font-size: 13px; color: var(--color-text-muted); }

.ctx-file-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  padding: 0 var(--spacing-sm);
}
.ctx-file-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  transition: all 0.2s;
  position: relative;
  min-width: 0;
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
  display: flex; align-items: center; gap: 8px; margin-top: 3px;
  font-size: 11px; color: var(--color-text-muted);
  flex-wrap: wrap;
}
.ctx-file-kind {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  color: var(--color-brand-accent);
  font-size: 10px;
  line-height: 1.5;
}

.ctx-file-actions {
  display: flex; gap: 2px;
  opacity: 0;
  transition: opacity 0.2s;
  flex-shrink: 0;
}
.ctx-file-item:hover .ctx-file-actions,
.ctx-file-item:focus-within .ctx-file-actions { opacity: 1; }
.ctx-file-actions--visible { opacity: 1; }
.ctx-action-danger {
  color: var(--color-error);
}
.ctx-action-danger:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}
@media (hover: none) {
  .ctx-file-actions { opacity: 1; }
}

.ctx-file-thumb-btn {
  padding: 0;
  border: none;
  background: none;
  cursor: zoom-in;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
}
.ctx-file-thumb {
  display: block;
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.ctx-file-thumb-btn:hover .ctx-file-thumb {
  transform: scale(1.04);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
}
.ctx-file-icon {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: rgba(var(--color-brand-accent-rgb), 0.08);
  color: var(--color-brand-accent);
}

</style>

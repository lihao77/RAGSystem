<template>
  <Teleport to="body">
    <div v-if="isDragOver" class="window-drop-overlay">
      <div class="window-drop-overlay__title">松手即可加入待发送附件</div>
      <div class="window-drop-overlay__desc">仅支持文件，不接收文件夹</div>
    </div>
  </Teleport>
  <div class="chat-input-area">
    <div class="input-container" :class="{ 'is-drag-over': isDragOver }">
      <div v-if="attachments.length" class="attachment-preview-list">
        <div v-for="attachment in attachments" :key="attachment.local_id || attachment.file_id || attachment.id || attachment.stored_name" class="attachment-preview-chip">
          <span class="attachment-preview-name">{{ attachment.original_name || attachment.stored_name }}</span>
          <button
            type="button"
            class="attachment-preview-remove"
            @click="emit('removeAttachment', attachment)"
            :disabled="isLoading"
            aria-label="移除附件"
          >
            ×
          </button>
        </div>
      </div>

      <div class="composer-shell">
        <div class="input-wrapper">
          <textarea
            v-model="inputText"
            @keydown.enter.prevent="handleEnter"
            @paste="handlePaste"
            placeholder="描述你想让 Agent 完成的任务..."
            rows="1"
            ref="textareaRef"
          ></textarea>
        </div>

        <div class="input-footer">
          <div class="input-footer-left">
            <button
              type="button"
              class="attachment-btn"
              :disabled="isLoading"
              @click="emit('openAttachments')"
              aria-label="打开附件面板"
              title="添加图片或文件"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="attachment-icon">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.82l8.49-8.48" />
              </svg>
            </button>

            <div v-if="$slots.footerMeta" class="input-footer-meta">
              <slot name="footerMeta" />
            </div>
          </div>

          <div class="input-footer-right">
            <slot name="rightActions" />
            <button
              v-if="isLoading"
              class="send-btn stop-btn"
              @click="handleStop"
              aria-label="Stop generation"
            >
              <span class="stop-icon">■</span>
            </button>
            <button
              v-else
              class="send-btn"
              :disabled="sendDisabled"
              @click="handleSend"
              aria-label="Send message"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="send-icon">
                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, defineProps, defineEmits, watch, nextTick, computed, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  isLoading: {
    type: Boolean,
    default: false
  },
  attachments: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['update:modelValue', 'send', 'stop', 'openAttachments', 'removeAttachment', 'pasteFiles']);

const inputText = ref(props.modelValue);
const textareaRef = ref(null);
const isDragOver = ref(false);

const sendDisabled = computed(() => props.isLoading || (!inputText.value.trim() && !props.attachments.length));

watch(() => props.modelValue, (newValue) => {
  inputText.value = newValue;
});

watch(inputText, (newValue) => {
  emit('update:modelValue', newValue);
  adjustTextareaHeight();
});

const adjustTextareaHeight = async () => {
  await nextTick();
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px';
  }
};

const extractClipboardFiles = (clipboardData) => {
  const items = Array.from(clipboardData?.items || []);
  return items
    .filter(item => item?.kind === 'file')
    .map(item => item.getAsFile())
    .filter(file => file instanceof File);
};

const extractDroppedFiles = (dataTransfer) => Array.from(dataTransfer?.files || []).filter(file => file instanceof File);

const getDataTransferItems = (dataTransfer) => Array.from(dataTransfer?.items || []);

const hasDirectoryEntry = (item) => {
  const entry = item?.webkitGetAsEntry?.();
  return Boolean(entry?.isDirectory);
};

const canAcceptDraggedFiles = (dataTransfer) => {
  const items = getDataTransferItems(dataTransfer);
  if (items.length) {
    const hasFileItem = items.some(item => item?.kind === 'file');
    if (!hasFileItem) return false;
    return !items.some(hasDirectoryEntry);
  }
  return extractDroppedFiles(dataTransfer).length > 0;
};

const handlePaste = (event) => {
  const files = extractClipboardFiles(event?.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  emit('pasteFiles', files);
};

const handleWindowDragEnter = (event) => {
  if (!canAcceptDraggedFiles(event?.dataTransfer)) return;
  isDragOver.value = true;
};

const handleWindowDragOver = (event) => {
  if (!canAcceptDraggedFiles(event?.dataTransfer)) {
    if (isDragOver.value) isDragOver.value = false;
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  isDragOver.value = true;
};

const handleWindowDragLeave = (event) => {
  if (event.relatedTarget || event.clientX > 0 || event.clientY > 0) return;
  isDragOver.value = false;
};

const handleWindowDrop = (event) => {
  if (!canAcceptDraggedFiles(event?.dataTransfer)) {
    isDragOver.value = false;
    return;
  }
  event.preventDefault();
  isDragOver.value = false;
  const files = extractDroppedFiles(event?.dataTransfer);
  if (files.length) {
    emit('pasteFiles', files);
  }
};

const handleEnter = (event) => {
  if (event.shiftKey) {
    return;
  }
  handleSend();
};

const handleSend = () => {
  const content = inputText.value.trim();
  if (props.isLoading || (!content && !props.attachments.length)) return;

  emit('send', {
    content,
    attachments: props.attachments,
  });
  inputText.value = '';
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
  }
};

const handleStop = () => {
  emit('stop');
};

const focus = async () => {
  await nextTick();
  if (textareaRef.value) {
    textareaRef.value.focus();
  }
};

onMounted(() => {
  window.addEventListener('dragenter', handleWindowDragEnter);
  window.addEventListener('dragover', handleWindowDragOver);
  window.addEventListener('dragleave', handleWindowDragLeave);
  window.addEventListener('drop', handleWindowDrop);
});

onUnmounted(() => {
  window.removeEventListener('dragenter', handleWindowDragEnter);
  window.removeEventListener('dragover', handleWindowDragOver);
  window.removeEventListener('dragleave', handleWindowDragLeave);
  window.removeEventListener('drop', handleWindowDrop);
});

defineExpose({ focus, extractClipboardFiles, extractDroppedFiles, canAcceptDraggedFiles });
</script>

<style scoped>
.chat-input-area {
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  position: relative;
}

.window-drop-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-toast, 5000) - 1);
  background:
    radial-gradient(circle at center, rgba(var(--color-brand-accent-rgb), 0.12) 0%, transparent 42%),
    rgba(var(--color-bg-overlay-rgb, 15, 23, 42), 0.28);
  backdrop-filter: blur(10px) saturate(130%);
  -webkit-backdrop-filter: blur(10px) saturate(130%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  pointer-events: none;
  text-align: center;
  padding: 24px;
}

.window-drop-overlay__title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--color-text-primary);
}

.window-drop-overlay__desc {
  font-size: 13px;
  color: var(--color-text-secondary, var(--color-text-muted));
}

.input-container {
  /* background: var(--glass-bg); */
  backdrop-filter: blur(40px);
  border: 2px solid var(--color-border);
  border-radius: 28px;
  padding: 10px;
  transition: all 0.3s;
  transform: translateY(0);
  box-shadow: var(--shadow-md);
}

.input-container.is-drag-over {
  border-color: rgba(var(--color-brand-accent-rgb), 0.55);
  box-shadow: 0 10px 28px rgba(var(--color-brand-accent-rgb), 0.18), 0 0 0 4px rgba(var(--color-brand-accent-rgb), 0.1);
}

.input-container:focus-within {
  border-color: var(--color-brand-accent);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15), 0 0 0 4px rgba(var(--color-brand-accent-rgb), 0.12);
  transform: translateY(-2px);
}

.composer-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.attachment-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 6px 10px;
}

.attachment-preview-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  font-size: 0.82rem;
  transition: all 0.3s;
  box-shadow: var(--shadow-sm);
}

.attachment-preview-chip:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.attachment-preview-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-preview-remove {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  transition: all 0.3s;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.attachment-preview-remove:hover {
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.1);
  transform: scale(1.1);
}

.input-wrapper {
  display: flex;
  align-items: stretch;
  min-height: 72px;
  background-color: transparent;
}

textarea {
  width: 100%;
  padding: 8px 10px 0;
  border: none;
  background: transparent;
  font-size: 0.96rem;
  font-family: inherit;
  resize: none;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.6;
  color: var(--color-text-primary);
  min-height: 64px;
}

textarea:focus {
  outline: none;
}

textarea::placeholder {
  color: var(--color-text-muted);
}

.input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 4px 2px;
  border-top: 1px solid var(--color-border);
  flex-wrap: nowrap;
}

.input-footer-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: wrap;
}

.input-footer-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: visible;
  flex-wrap: wrap;
}

.input-footer-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.attachment-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.3s;
  flex-shrink: 0;
}

.attachment-btn:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--color-hover-overlay);
  border-color: var(--color-border);
}

.attachment-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.attachment-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.attachment-icon {
  width: 18px;
  height: 18px;
}

.send-btn {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--color-brand-accent);
  color: var(--color-on-color);
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.3s;
  margin: 0;
  box-shadow: 0 2px 8px rgba(var(--color-brand-accent-rgb), 0.3);
}

.send-btn:hover:not(:disabled) {
  background: var(--color-brand-accent-light);
  transform: scale(1.05);
  box-shadow: 0 4px 16px rgba(var(--color-brand-accent-rgb), 0.4);
}

.send-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.send-btn:disabled {
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: not-allowed;
  border: 1px solid var(--color-border);
  opacity: 0.5;
  box-shadow: none;
}

.send-icon {
  width: 18px;
  height: 18px;
}

.stop-btn {
  background: var(--color-error) !important;
  border: none !important;
  color: var(--color-on-color) !important;
  opacity: 1 !important;
  cursor: pointer !important;
  box-shadow: 0 2px 8px rgba(var(--color-error-rgb), 0.3) !important;
}

.stop-btn:hover {
  opacity: 0.9 !important;
  transform: scale(1.05) !important;
  box-shadow: 0 4px 16px rgba(var(--color-error-rgb), 0.4) !important;
}

.stop-btn:active {
  transform: scale(0.95) !important;
}

.stop-icon {
  font-size: 14px;
  line-height: 1;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-radius: 50%;
  border-top-color: var(--color-interactive);
  animation: spin 0.8s linear infinite;
}

@media (max-width: 640px) {
  .input-container {
    border-radius: 24px;
    padding: 8px;
  }

  textarea {
    min-height: 56px;
    padding-left: 8px;
    padding-right: 8px;
  }

  .input-footer {
    gap: 8px;
    padding-top: 8px;
  }

  .input-footer-left {
    gap: 8px;
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

<template>
  <div class="msg-edit-box">
    <div class="msg-edit-textarea-wrapper">
      <textarea
        ref="textareaRef"
        class="msg-edit-textarea"
        :value="modelValue"
        :disabled="submitting"
        placeholder="编辑消息内容..."
        @input="onInput"
        @focus="isFocused = true"
        @blur="isFocused = false"
        @keydown.ctrl.enter.prevent="$emit('confirm')"
        @keydown.meta.enter.prevent="$emit('confirm')"
        @keydown.esc.prevent="$emit('cancel')"
      />
    </div>
    <div v-if="attachments.length" class="msg-edit-attachments">
      <div
        v-for="att in attachments"
        :key="att.local_id || att.file_id || att.id"
        class="msg-edit-att-card"
      >
        <AuthenticatedImage
          v-if="isImage(att)"
          :src="previewUrl(att)"
          :alt="att.original_name || att.stored_name"
          class="msg-edit-att-img"
        />
        <div v-else class="msg-edit-att-file-icon">
          <IconFile :size="16" />
        </div>
        <div class="msg-edit-att-info">
          <span class="msg-edit-att-name">{{ att.original_name || att.stored_name }}</span>
        </div>
        <Button variant="ghost" size="icon" aria-label="移除附件" title="移除附件" :disabled="submitting" @click="$emit('removeAttachment', att)">
          <IconClose :size="14" />
        </Button>
      </div>
    </div>
    <div class="msg-edit-action-bar">
      <Button variant="ghost" size="sm" :disabled="submitting" @click="$emit('openAttachments')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        <span>附件</span>
      </Button>
      <div class="msg-edit-hint">
        <span class="hint-text">{{ isFocused ? 'Ctrl+Enter 提交 · Esc 取消' : '' }}</span>
      </div>
      <Button variant="ghost" size="sm" :disabled="submitting" @click="$emit('cancel')">
        <IconClose :size="14" />
        <span>取消</span>
      </Button>
      <Button variant="default" size="sm" :disabled="submitting" @click="$emit('confirm')">
        <IconCheck v-if="!submitting" :size="14" :stroke-width="2.5" />
        <svg v-else class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
          </svg>
        <span>{{ submitting ? '提交中' : '确定' }}</span>
      </Button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, watch } from 'vue';
import { getSessionFileDownloadUrl, isImageAttachment, isLocalAttachment } from '../utils/sessionAttachments';
import IconCheck from './icons/IconCheck.vue';
import IconClose from './icons/IconClose.vue';
import IconFile from './icons/IconFile.vue';
import AuthenticatedImage from './common/AuthenticatedImage.vue';
import { Button } from './ui/button';

const props = defineProps({
  modelValue: { type: String, default: '' },
  attachments: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
  sessionId: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel', 'openAttachments', 'removeAttachment']);

const textareaRef = ref(null);
const isFocused = ref(false);

const isImage = (att) => isImageAttachment(att);
const previewUrl = (att) => {
  if (isLocalAttachment(att)) return att.preview_url || '';
  return props.sessionId && att?.file_id
    ? getSessionFileDownloadUrl(props.sessionId, att.file_id)
    : '';
};

const autoResize = () => {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 320) + 'px';
};

const onInput = (e) => {
  emit('update:modelValue', e.target.value);
  autoResize();
};

watch(() => props.modelValue, () => {
  nextTick(autoResize);
});

onMounted(async () => {
  await nextTick();
  autoResize();
  const el = textareaRef.value;
  if (el) {
    el.focus();
    el.selectionStart = el.selectionEnd = el.value.length;
  }
});
</script>

<style scoped>
.msg-edit-box {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  box-sizing: border-box;
  padding: 20px;
  background: var(--color-bg-secondary);
  border: 1.5px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  transition: all 0.3s;
}

.msg-edit-box:focus-within {
  border-color: var(--color-brand-accent);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15), 0 0 0 4px rgba(var(--color-brand-accent-rgb), 0.12);
  transform: translateY(-2px);
}

.msg-edit-textarea-wrapper {
  position: relative;
}

.msg-edit-textarea {
  width: 100%;
  min-height: 80px;
  max-height: 320px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  outline: none;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  line-height: 1.6;
  font-family: inherit;
  resize: none;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  transition: all 0.3s;
}

.msg-edit-textarea::placeholder {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.msg-edit-textarea:focus {
  border-color: var(--color-brand-accent);
  background: var(--color-bg-primary);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.1);
}

.msg-edit-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  background: var(--color-bg-tertiary);
}

.msg-edit-attachments {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.msg-edit-att-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  transition: all 0.3s;
}

.msg-edit-att-card:hover {
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}

.msg-edit-att-img {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}

.msg-edit-att-file-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.msg-edit-att-info {
  flex: 1;
  min-width: 0;
}

.msg-edit-att-name {
  display: block;
  font-size: 0.875rem;
  color: var(--color-text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-edit-att-remove {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: all 0.3s;
  flex-shrink: 0;
}

.msg-edit-att-remove:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
  transform: scale(1.15);
}

.msg-edit-att-remove:active:not(:disabled) {
  transform: scale(0.95);
}

.msg-edit-att-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.msg-edit-action-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 2px;
}

.msg-edit-hint {
  flex: 1;
  display: flex;
  justify-content: center;
  min-width: 0;
}

.hint-text {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  opacity: 0.8;
  white-space: nowrap;
  transition: opacity 0.2s ease;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.spinner {
  animation: g-spin 0.8s linear infinite;
}
</style>

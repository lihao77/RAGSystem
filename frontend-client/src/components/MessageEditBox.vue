<template>
  <div class="msg-edit-box">
    <textarea
      ref="textareaRef"
      class="msg-edit-textarea"
      :value="modelValue"
      :disabled="submitting"
      @input="onInput"
      @keydown.ctrl.enter.prevent="$emit('confirm')"
      @keydown.meta.enter.prevent="$emit('confirm')"
      @keydown.esc.prevent="$emit('cancel')"
    />
    <div v-if="attachments.length" class="msg-edit-attachments">
      <div
        v-for="att in attachments"
        :key="att.file_id || att.id"
        class="msg-edit-att-card"
      >
        <img
          v-if="isImage(att)"
          :src="previewUrl(att)"
          :alt="att.original_name || att.stored_name"
          class="msg-edit-att-img"
        />
        <div v-else class="msg-edit-att-file-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="msg-edit-att-info">
          <span class="msg-edit-att-name">{{ att.original_name || att.stored_name }}</span>
        </div>
        <button
          type="button"
          class="msg-edit-att-remove"
          :disabled="submitting"
          title="移除"
          @click="$emit('removeAttachment', att)"
        >×</button>
      </div>
    </div>
    <div class="msg-edit-action-bar">
      <button type="button" class="msg-edit-btn msg-edit-btn-attach" :disabled="submitting" @click="$emit('openAttachments')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
        </svg>
        附件
      </button>
      <div class="msg-edit-spacer" />
      <button type="button" class="msg-edit-btn msg-edit-btn-cancel" :disabled="submitting" @click="$emit('cancel')">取消</button>
      <button type="button" class="msg-edit-btn msg-edit-btn-confirm" :disabled="submitting" @click="$emit('confirm')">
        {{ submitting ? '提交中…' : '确定' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, watch } from 'vue';
import { getSessionFileDownloadUrl } from '../api/sessionFiles';

const props = defineProps({
  modelValue: { type: String, default: '' },
  attachments: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
  sessionId: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel', 'openAttachments', 'removeAttachment']);

const textareaRef = ref(null);

const isImage = (att) => String(att?.mime || '').startsWith('image/');
const previewUrl = (att) =>
  props.sessionId && att?.file_id
    ? getSessionFileDownloadUrl(props.sessionId, att.file_id)
    : '';

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
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.msg-edit-textarea {
  width: 100%;
  min-height: 80px;
  max-height: 320px;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  line-height: 1.6;
  font-family: inherit;
  resize: none;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-edit-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.msg-edit-attachments {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.msg-edit-att-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color 180ms ease, box-shadow 180ms ease;
}

.msg-edit-att-card:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.msg-edit-att-img {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.msg-edit-att-file-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.msg-edit-att-info {
  flex: 1;
  min-width: 0;
}

.msg-edit-att-name {
  display: block;
  font-size: 0.85rem;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-edit-att-remove {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 180ms ease, color 180ms ease;
  flex-shrink: 0;
}

.msg-edit-att-remove:hover:not(:disabled) {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.msg-edit-att-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.msg-edit-action-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}

.msg-edit-spacer {
  flex: 1;
}

.msg-edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-size: 0.8rem;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 180ms ease;
  outline: none;
  white-space: nowrap;
}

.msg-edit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.msg-edit-btn-attach {
  background: transparent;
  color: var(--color-text-muted);
  border-color: var(--color-border);
}

.msg-edit-btn-attach:hover:not(:disabled) {
  background: var(--color-hover-overlay);
  border-color: var(--color-border-hover);
  color: var(--color-text-secondary);
}

.msg-edit-btn-cancel {
  background: transparent;
  color: var(--color-text-muted);
}

.msg-edit-btn-cancel:hover:not(:disabled) {
  background: var(--color-hover-overlay);
  color: var(--color-text-secondary);
}

.msg-edit-btn-confirm {
  background: var(--color-brand-accent);
  color: white;
  border-color: var(--color-brand-accent);
}

.msg-edit-btn-confirm:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(var(--color-brand-accent-rgb), 0.3);
}

.msg-edit-btn-confirm:active:not(:disabled) {
  transform: translateY(0);
}
</style>

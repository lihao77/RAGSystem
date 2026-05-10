<template>
  <div class="message-actions" :class="{ visible }">
    <template v-if="msg.role === 'user' && editingMessage !== msg">
      <button type="button" class="msg-action-btn btn-edit" :disabled="isLoading" title="编辑" @click="startEditMessage(msg)">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </button>
      <button type="button" class="msg-action-btn btn-copy" title="复制" @click="copyMessage(msg)">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      </button>
    </template>

    <template v-if="msg.role === 'assistant' && msg.finished">
      <button
        v-if="showWorkPanel && hasExecutionContent(msg)"
        type="button"
        class="msg-action-btn btn-execution-tree"
        :class="{ active: selectedWorkPanelMessageKey === getWorkPanelMessageKey(msg) }"
        title="在工作栏查看执行树"
        @click="selectWorkPanelMessage(msg)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 3v12" />
          <circle cx="6" cy="18" r="3" />
          <path d="M6 9h8" />
          <circle cx="17" cy="9" r="3" />
        </svg>
      </button>
      <button type="button" class="msg-action-btn btn-copy" title="复制" @click="copyMessage(msg)">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      </button>
      <button
        v-if="retryMessage"
        type="button"
        class="msg-action-btn btn-retry"
        :disabled="isLoading"
        title="重试"
        @click="rollbackAndRetry(retryMessage)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 16h5v5" />
        </svg>
      </button>
      <span
        v-if="getMessageExecutionTimeText(msg)"
        class="message-execution-time"
        :title="getMessageExecutionTimeTitle(msg)"
      >
        {{ getMessageExecutionTimeText(msg) }}
      </span>
    </template>
  </div>
</template>

<script setup>
defineProps({
  msg: { type: Object, required: true },
  visible: { type: Boolean, default: false },
  showWorkPanel: { type: Boolean, default: false },
  isLoading: { type: Boolean, default: false },
  selectedWorkPanelMessageKey: { type: String, default: '' },
  retryMessage: { type: Object, default: null },
  editingMessage: { type: Object, default: null },
  hasExecutionContent: { type: Function, required: true },
  startEditMessage: { type: Function, required: true },
  copyMessage: { type: Function, required: true },
  getWorkPanelMessageKey: { type: Function, required: true },
  selectWorkPanelMessage: { type: Function, required: true },
  rollbackAndRetry: { type: Function, required: true },
  getMessageExecutionTimeText: { type: Function, required: true },
  getMessageExecutionTimeTitle: { type: Function, required: true },
});
</script>

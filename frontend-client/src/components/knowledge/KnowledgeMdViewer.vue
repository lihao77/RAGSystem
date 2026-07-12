<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-[960px] max-h-[88vh] overflow-hidden flex flex-col">
      <DialogHeader>
        <DialogTitle>{{ fileName || 'Markdown 预览' }}</DialogTitle>
      </DialogHeader>
      <div v-if="loading" class="py-12 text-center text-muted-foreground">正在加载 Markdown...</div>
      <div v-else-if="error" class="py-12 text-center text-destructive">{{ error }}</div>
      <div v-else class="knowledge-md-preview overflow-auto rounded-md border p-5">
        <MarkdownContent :content="markdown" @notify="handleNotify" />
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { ref, watch } from 'vue';
import MarkdownContent from '../chat/MarkdownContent.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { getFileMd } from '../../api/knowledgeBase.js';

const props = defineProps({ open: Boolean, fileId: { type: String, default: '' }, fileName: { type: String, default: '' } });
const emit = defineEmits(['update:open', 'notify']);
const loading = ref(false);
const markdown = ref('');
const error = ref('');

watch(() => [props.open, props.fileId], async ([open, fileId]) => {
  if (!open || !fileId) return;
  loading.value = true;
  markdown.value = '';
  error.value = '';
  try {
    const result = await getFileMd(fileId);
    markdown.value = result.markdown || '';
  } catch (requestError) {
    error.value = requestError.message || 'Markdown 预览加载失败';
  } finally {
    loading.value = false;
  }
}, { immediate: true });

function handleNotify(payload) { emit('notify', payload); }
</script>

<style scoped>
.knowledge-md-preview { min-height: 360px; background: var(--background); }
</style>

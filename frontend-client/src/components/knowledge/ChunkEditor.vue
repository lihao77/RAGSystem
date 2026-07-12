<template><div class="space-y-2"><textarea v-model="draft" class="min-h-40 w-full rounded border p-2 text-sm"></textarea><div class="flex justify-end gap-2"><button class="rounded border px-3 py-1" @click="emit('cancel')">取消</button><button class="rounded bg-primary px-3 py-1 text-primary-foreground" :disabled="saving" @click="save">{{ saving ? '保存中...' : '保存并重嵌入' }}</button></div></div></template>
<script setup>
import { ref } from 'vue';
import { updateFileChunk } from '../../api/knowledgeBase.js';
const props = defineProps({ fileId: String, chunk: Object }); const emit = defineEmits(['saved', 'cancel', 'notify']); const draft = ref(props.chunk?.content || ''); const saving = ref(false);
const save = async () => { saving.value = true; try { const result = await updateFileChunk(props.fileId, props.chunk.id, draft.value); emit('saved', result.data); } catch (error) { emit('notify', { message: error.message || '切片保存失败', type: 'error' }); } finally { saving.value = false; } };
</script>

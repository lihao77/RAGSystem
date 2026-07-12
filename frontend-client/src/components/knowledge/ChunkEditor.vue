<template>
  <div class="space-y-3">
    <textarea
      v-model="draft"
      class="msg-edit-textarea min-h-40 w-full rounded-md border border-border bg-background p-3 text-sm text-foreground"
    ></textarea>
    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" @click="emit('cancel')">取消</Button>
      <Button variant="default" size="sm" :disabled="saving" @click="save">
        <IconSave :size="14" />
        {{ saving ? '保存中...' : '保存并重嵌入' }}
      </Button>
    </div>
  </div>
</template>
<script setup>
import { ref } from 'vue';
import { updateFileChunk } from '../../api/knowledgeBase.js';
import { Button } from '../ui/button';
import IconSave from '../icons/IconSave.vue';
const props = defineProps({ fileId: String, chunk: Object }); const emit = defineEmits(['saved', 'cancel', 'notify']); const draft = ref(props.chunk?.content || ''); const saving = ref(false);
const save = async () => { saving.value = true; try { const result = await updateFileChunk(props.fileId, props.chunk.id, draft.value); emit('saved', result.data); } catch (error) { emit('notify', { message: error.message || '切片保存失败', type: 'error' }); } finally { saving.value = false; } };
</script>

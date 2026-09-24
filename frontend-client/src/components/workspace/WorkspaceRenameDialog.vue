<template>
  <Dialog v-model:open="openModel">
    <DialogContent class="workspace-dialog">
      <DialogHeader>
        <DialogTitle>重命名项目</DialogTitle>
        <DialogDescription>只修改显示名称，不影响文件夹路径。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel for="workspace-rename-name">项目名称</FieldLabel>
          <Input
            id="workspace-rename-name"
            ref="nameInput"
            v-model="name"
            placeholder="输入项目名称"
            maxlength="120"
            autocomplete="off"
            @keydown.enter.prevent="submit"
          />
        </Field>
        <Field v-if="workspace?.root_path">
          <FieldLabel>文件夹路径</FieldLabel>
          <p class="workspace-rename-path" :title="workspace.root_path">{{ workspace.root_path }}</p>
        </Field>
      </FieldGroup>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <DialogFooter>
        <Button variant="outline" @click="openModel = false">取消</Button>
        <Button :disabled="renaming || !canSubmit" @click="submit">{{ renaming ? '保存中…' : '保存' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useWorkspaceStore } from '@/stores/workspace.js';

const props = defineProps({
  chatSdkClient: { type: Object, required: true },
  workspace: { type: Object, default: null },
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'renamed']);

const store = useWorkspaceStore();
const { error } = storeToRefs(store);
store.setClient(props.chatSdkClient);

const name = ref('');
const renaming = ref(false);
const nameInput = ref(null);
const openModel = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value),
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      error.value = '';
      name.value = props.workspace?.display_name || '';
      void nextTick(() => nameInput.value?.$el?.focus?.());
    }
  },
);

const canSubmit = computed(() => {
  const trimmed = name.value.trim();
  return trimmed.length > 0 && trimmed !== props.workspace?.display_name;
});

async function submit() {
  if (!canSubmit.value || renaming.value) return;
  if (!props.workspace?.workspace_id) return;
  renaming.value = true;
  error.value = '';
  try {
    const workspace = await store.rename(props.workspace.workspace_id, name.value.trim());
    openModel.value = false;
    emit('renamed', workspace);
  } catch { /* surfaced in dialog */ } finally {
    renaming.value = false;
  }
}
</script>

<style scoped>
.workspace-dialog { width: min(480px, calc(100vw - 24px)); }
.workspace-rename-path {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
</style>

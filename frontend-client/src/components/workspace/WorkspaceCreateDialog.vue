<template>
  <Dialog v-model:open="open">
    <DialogContent class="workspace-dialog" @close-auto-focus="$emit('close-auto-focus', $event)">
      <DialogHeader>
        <DialogTitle>添加本地项目</DialogTitle>
        <DialogDescription>选择一个本地文件夹作为项目。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel :for="rootInputId">项目文件夹</FieldLabel>
          <div class="workspace-dialog-input">
            <Input :id="rootInputId" v-model="rootPath" placeholder="例如 D:/projects/my-app" autocomplete="off" spellcheck="false" />
            <Button v-if="isDesktop" type="button" variant="outline" @click="chooseFolder">
              <FolderOpen data-icon="inline-start" /> 浏览
            </Button>
          </div>
          <FieldDescription>浏览器模式下也可以直接输入已存在的绝对路径。</FieldDescription>
        </Field>
      </FieldGroup>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button :disabled="creating || !rootPath.trim()" @click="createWorkspace">{{ creating ? '添加中…' : '添加项目' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { FolderOpen } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useWorkspaceStore } from '@/stores/workspace.js';

const open = defineModel({ type: Boolean, default: false });
const emit = defineEmits(['created', 'close-auto-focus']);
const store = useWorkspaceStore();
const { creating, error } = storeToRefs(store);
const rootPath = ref('');
const rootInputId = useId();
const isDesktop = typeof window !== 'undefined' && typeof window.ragsystemDesktop?.selectProjectFolder === 'function';

watch(open, (value) => {
  if (value) {
    error.value = '';
    rootPath.value = '';
  }
});

async function chooseFolder() {
  const result = await window.ragsystemDesktop.selectProjectFolder();
  if (!result?.canceled && result.path) rootPath.value = result.path.replaceAll('\\', '/');
}

async function createWorkspace() {
  if (creating.value || !rootPath.value.trim()) return;
  try {
    const workspace = await store.create(rootPath.value);
    open.value = false;
    emit('created', workspace);
  } catch { /* surfaced in dialog */ }
}
</script>

<style scoped>
.workspace-dialog { width: min(520px, calc(100vw - 24px)); }
.workspace-dialog-input { display: flex; align-items: center; gap: 8px; }
.workspace-dialog-input > :first-child { min-width: 0; flex: 1; }
@media (max-width: 480px) {
  .workspace-dialog-input { align-items: stretch; flex-direction: column; }
}
</style>

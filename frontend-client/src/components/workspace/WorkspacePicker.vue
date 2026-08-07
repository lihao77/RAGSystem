<template>
  <div class="workspace-picker">
    <Button
      variant="ghost"
      size="icon-xs"
      class="workspace-picker-trigger"
      aria-label="添加本地项目"
      title="添加本地项目"
      @click="openCreateDialog"
    >
      <FolderPlus />
    </Button>

    <Dialog v-model:open="createOpen">
      <DialogContent class="workspace-dialog">
        <DialogHeader>
          <DialogTitle>添加本地项目</DialogTitle>
          <DialogDescription>选择一个本地文件夹。项目下创建的所有新聊天都会复用这个工作空间。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel for="workspace-root">项目文件夹</FieldLabel>
            <div class="workspace-dialog-input">
              <Input id="workspace-root" v-model="rootPath" placeholder="例如 D:/projects/my-app" autocomplete="off" spellcheck="false" />
              <Button v-if="isDesktop" type="button" variant="outline" @click="chooseFolder">
                <FolderOpen data-icon="inline-start" /> 浏览
              </Button>
            </div>
            <FieldDescription>浏览器模式下也可以直接输入已存在的绝对路径。</FieldDescription>
          </Field>
        </FieldGroup>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button variant="outline" @click="createOpen = false">取消</Button>
          <Button :disabled="creating || !rootPath.trim()" @click="createWorkspace">{{ creating ? '添加中…' : '添加项目' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { FolderOpen, FolderPlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useWorkspaceStore } from '@/stores/workspace.js';

const props = defineProps({ chatSdkClient: { type: Object, required: true } });
const emit = defineEmits(['change']);
const store = useWorkspaceStore();
const { creating, error } = storeToRefs(store);
const createOpen = ref(false);
const rootPath = ref('');
const isDesktop = typeof window !== 'undefined' && typeof window.ragsystemDesktop?.selectProjectFolder === 'function';

store.setClient(props.chatSdkClient);

function openCreateDialog() {
  error.value = '';
  rootPath.value = '';
  createOpen.value = true;
}
async function chooseFolder() {
  const result = await window.ragsystemDesktop.selectProjectFolder();
  if (!result?.canceled && result.path) rootPath.value = result.path.replaceAll('\\', '/');
}
async function createWorkspace() {
  try {
    const workspace = await store.create(rootPath.value);
    createOpen.value = false;
    emit('change', workspace);
  } catch { /* surfaced in dialog */ }
}
</script>

<style scoped>
.workspace-picker { flex: 0 0 auto; min-width: 0; }
.workspace-picker-trigger { color: var(--color-text-muted); }
.workspace-dialog { width: min(520px, calc(100vw - 24px)); }
.workspace-dialog-input { display: flex; align-items: center; gap: 8px; }
.workspace-dialog-input > :first-child { min-width: 0; flex: 1; }
@media (max-width: 480px) {
  .workspace-dialog-input { align-items: stretch; flex-direction: column; }
}
</style>

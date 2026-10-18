<template>
  <div class="workspace-picker">
    <Button
      variant="ghost"
      size="icon-xs"
      class="workspace-picker-trigger"
      aria-label="添加本地项目"
      title="添加本地项目"
      @click="createOpen = true"
    >
      <FolderPlus data-icon="inline-start" />
    </Button>

    <WorkspaceCreateDialog v-model="createOpen" @created="$emit('change', $event)" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { FolderPlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import WorkspaceCreateDialog from './WorkspaceCreateDialog.vue';
import { useWorkspaceStore } from '@/stores/workspace.js';

const props = defineProps({ chatSdkClient: { type: Object, required: true } });
defineEmits(['change']);
const store = useWorkspaceStore();
const createOpen = ref(false);

store.setClient(props.chatSdkClient);
</script>

<style scoped>
.workspace-picker { flex: 0 0 auto; min-width: 0; }
.workspace-picker-trigger { color: var(--color-text-muted); }
</style>

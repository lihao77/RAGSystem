<template>
  <div class="session-setup-panel" aria-label="新会话上下文">
    <Dialog v-model:open="projectDialogOpen">
      <DialogTrigger as-child>
        <Button
          variant="ghost"
          size="xs"
          class="project-trigger"
          :disabled="workspaceLoading"
          :title="currentWorkspace?.root_path || projectLabel"
        >
          <FolderOpen data-icon="inline-start" />
          <span class="truncate">{{ projectLabel }}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DialogTrigger>
      <DialogContent
        class="project-picker-dialog max-h-[min(620px,calc(100dvh-24px))] w-[min(480px,calc(100vw-24px))] max-w-none gap-3 overflow-hidden rounded-lg p-4"
      >
        <DialogHeader class="project-picker-header">
          <DialogTitle class="project-picker-title">选择项目</DialogTitle>
          <DialogDescription class="sr-only">选择新会话使用的本地项目</DialogDescription>
        </DialogHeader>
        <ul v-if="workspaces.length" class="project-list" aria-label="项目列表">
          <li v-for="workspace in workspaces" :key="workspace.workspace_id">
            <button
              type="button"
              class="project-option"
              :class="{ 'is-selected': workspace.workspace_id === currentWorkspaceId }"
              :aria-pressed="workspace.workspace_id === currentWorkspaceId"
              @click="selectWorkspace(workspace.workspace_id)"
            >
              <FolderKanban class="project-option-icon" aria-hidden="true" />
              <span class="project-option-copy">
                <span class="project-option-name">{{ workspace.display_name }}</span>
                <span v-if="workspace.root_path" class="project-option-path">{{ workspace.root_path }}</span>
              </span>
              <Check v-if="workspace.workspace_id === currentWorkspaceId" class="project-option-check" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-else class="project-list-empty">暂无项目</p>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="settingsOpen">
      <DialogTrigger as-child>
        <Button variant="ghost" size="icon-xs" aria-label="新会话设置" title="新会话设置">
          <SlidersHorizontal />
        </Button>
      </DialogTrigger>
      <DialogContent class="launch-settings-dialog w-[min(460px,calc(100vw-24px))] max-w-none rounded-lg">
        <DialogHeader>
          <DialogTitle>新会话设置</DialogTitle>
          <DialogDescription>选择本次会话使用的 Team 和入口 Agent。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel for="new-chat-team">Team</FieldLabel>
            <CustomSelect
              trigger-id="new-chat-team"
              trigger-aria-label="Team"
              :model-value="team"
              :options="teamOptions"
              :disabled="teamSelectDisabled"
              :dropdown-max-height="320"
              dropdown-placement="auto"
              :placeholder="teamPlaceholder"
              @update:modelValue="emit('update:team', $event)"
            />
          </Field>
          <Field>
            <FieldLabel for="new-chat-entry-agent">入口 Agent</FieldLabel>
            <CustomSelect
              trigger-id="new-chat-entry-agent"
              trigger-aria-label="入口 Agent"
              :model-value="entryAgent"
              :options="entryAgentOptions"
              :disabled="entryAgentLoading || teamLoading"
              :dropdown-max-height="320"
              dropdown-placement="auto"
              :placeholder="entryAgentPlaceholder"
              @update:modelValue="emit('update:entryAgent', $event)"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button size="sm" @click="settingsOpen = false">完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Check, ChevronDown, FolderKanban, FolderOpen, SlidersHorizontal } from 'lucide-vue-next';
import CustomSelect from '../ui/CustomSelect.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { useWorkspaceStore } from '../../stores/workspace.js';

const props = defineProps({
  team: { type: String, default: '' },
  teamOptions: { type: Array, default: () => [] },
  teamLoading: { type: Boolean, default: false },
  entryAgent: { type: String, default: '' },
  entryAgentOptions: { type: Array, default: () => [] },
  entryAgentLoading: { type: Boolean, default: false },
  workspaceRoot: { type: String, default: '' },
});

const emit = defineEmits(['update:team', 'update:entryAgent', 'update:workspaceRoot']);
const workspaceStore = useWorkspaceStore();
const {
  items: workspaces,
  currentWorkspaceId,
  currentWorkspace,
  loading: workspaceLoading,
} = storeToRefs(workspaceStore);
const projectDialogOpen = ref(false);
const settingsOpen = ref(false);

const projectLabel = computed(() => {
  if (workspaceLoading.value) return '加载项目…';
  if (currentWorkspace.value) return currentWorkspace.value.display_name;
  return '选择项目';
});
const teamSelectDisabled = computed(() => props.teamLoading || props.teamOptions.length === 0);
const teamPlaceholder = computed(() => {
  if (props.teamLoading) return '加载 Team…';
  if (props.teamOptions.length === 0) return '暂无 Team';
  return '使用默认 Team';
});
const entryAgentPlaceholder = computed(() => {
  if (props.teamLoading || props.entryAgentLoading) return '加载 Agent…';
  if (props.entryAgentOptions.length === 0) return '使用服务端默认 Agent';
  return '使用默认 Agent';
});

function selectWorkspace(id) {
  const workspace = workspaceStore.select(id);
  emit('update:workspaceRoot', workspace?.root_path || '');
  projectDialogOpen.value = false;
}

watch(currentWorkspace, (workspace) => {
  const rootPath = workspace?.root_path || '';
  if (rootPath !== props.workspaceRoot) emit('update:workspaceRoot', rootPath);
}, { immediate: true });
</script>

<style scoped>
.session-setup-panel {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 4px 6px;
}

.project-trigger {
  max-width: min(70%, 320px);
  justify-content: flex-start;
  color: var(--color-text-secondary);
}

.project-trigger :deep(svg) {
  width: 14px;
  height: 14px;
}

.project-trigger > span {
  min-width: 0;
}

.project-picker-header {
  padding: 0 2px;
  text-align: left;
}

.project-picker-title {
  font-size: 14px;
  line-height: 20px;
  letter-spacing: 0;
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.project-option {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
}

.project-option:hover,
.project-option:focus-visible {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
  outline: none;
}

.project-option.is-selected {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
}

.project-option-icon,
.project-option-check {
  width: 16px;
  height: 16px;
  flex: none;
}

.project-option-icon {
  color: var(--color-text-muted);
}

.project-option-check {
  width: 14px;
  height: 14px;
  justify-self: end;
  color: var(--color-brand-accent-light);
}

.project-option-copy {
  display: block;
  min-width: 0;
}

.project-option-name,
.project-option-path {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0;
}

.project-option-name {
  color: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.project-option-path {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 16px;
}

.project-list-empty {
  padding: 28px 12px;
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: center;
}

</style>

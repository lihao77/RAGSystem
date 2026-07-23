<template>
  <section class="session-setup-panel" aria-labelledby="session-setup-title">
    <div class="session-setup-heading">
      <h2 id="session-setup-title">启动设置</h2>
      <p>仅影响即将创建的新会话</p>
    </div>

    <FieldGroup class="session-setup-fields">
      <Field class="setup-field">
        <FieldLabel for="new-chat-entry-agent">入口 Agent</FieldLabel>
        <CustomSelect
          trigger-id="new-chat-entry-agent"
          trigger-aria-label="入口 Agent"
          :model-value="entryAgent"
          :options="entryAgentOptions"
          :disabled="entryAgentLoading"
          :dropdown-max-height="320"
          dropdown-placement="auto"
          placeholder="使用默认 Agent"
          @update:modelValue="emit('update:entryAgent', $event)"
        />
      </Field>

      <Field class="setup-field">
        <FieldLabel for="new-chat-workspace-root">工作目录</FieldLabel>
        <div class="workspace-control">
          <Input
            id="new-chat-workspace-root"
            class="workspace-input"
            :model-value="workspaceRoot"
            placeholder="输入项目路径"
            autocomplete="off"
            spellcheck="false"
            @update:model-value="emit('update:workspaceRoot', $event)"
            @blur="emit('update:workspaceRoot', normalizeWorkspaceRootInput($event.target.value))"
          />
          <Button
            v-if="isDesktop"
            type="button"
            variant="outline"
            title="选择项目目录"
            @click="selectProjectFolder"
          >
            <FolderOpen data-icon="inline-start" />
            选择目录
          </Button>
        </div>
      </Field>
    </FieldGroup>
  </section>
</template>

<script setup>
import { FolderOpen } from 'lucide-vue-next';
import CustomSelect from '../ui/CustomSelect.vue';
import { Button } from '../ui/button';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';

const props = defineProps({
  entryAgent: { type: String, default: '' },
  entryAgentOptions: { type: Array, default: () => [] },
  entryAgentLoading: { type: Boolean, default: false },
  workspaceRoot: { type: String, default: '' },
  normalizeWorkspaceRootInput: { type: Function, required: true },
});

const emit = defineEmits([
  'update:entryAgent',
  'update:workspaceRoot',
]);

const isDesktop = typeof window !== 'undefined' && typeof window.ragsystemDesktop?.selectProjectFolder === 'function';

const selectProjectFolder = async () => {
  const result = await window.ragsystemDesktop.selectProjectFolder();
  if (!result?.canceled && result?.path) {
    emit('update:workspaceRoot', props.normalizeWorkspaceRootInput(result.path).replaceAll('\\', '/'));
  }
};
</script>

<style scoped>
.session-setup-panel {
  width: 100%;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: rgba(var(--color-bg-elevated-rgb), 0.46);
}

.session-setup-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.session-setup-heading h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 700;
}

.session-setup-heading p {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.session-setup-fields {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr);
  gap: 12px;
}

.setup-field {
  min-width: 0;
  gap: 7px;
}

.workspace-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.workspace-input {
  min-width: 0;
  flex: 1 1 auto;
}

.workspace-control > :last-child {
  flex: 0 0 auto;
}

@media (max-width: 767px) {
  .session-setup-panel {
    padding: 14px;
  }

  .session-setup-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .session-setup-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

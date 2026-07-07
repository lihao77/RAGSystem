<template>
  <section class="session-setup-bar" aria-label="启动参数">
    <label class="setup-field setup-field--agent" title="入口 Agent">
      <CustomSelect
        :model-value="entryAgent"
        :options="entryAgentOptions"
        :disabled="entryAgentLoading"
        :dropdown-max-height="320"
        dropdown-placement="auto"
        placeholder="默认 agent"
        @update:modelValue="emit('update:entryAgent', $event)"
      />
    </label>

    <label class="setup-field setup-field--path" title="工作区">
      <Input
        :model-value="workspaceRoot"
        placeholder="工作目录"
        autocomplete="off"
        spellcheck="false"
        @update:model-value="emit('update:workspaceRoot', $event)"
        @blur="emit('update:workspaceRoot', normalizeWorkspaceRootInput($event.target.value))"
      />
    </label>
  </section>
</template>

<script setup>
import CustomSelect from '../ui/CustomSelect.vue';
import { Input } from '../ui/input';

defineProps({
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
</script>

<style scoped>
.session-setup-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  overflow: visible;
}

.setup-field {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-elevated);
  transition: border-color 180ms ease, box-shadow 180ms ease;
}

.setup-field:hover {
  border-color: var(--color-border-hover);
}

.setup-field:focus-within {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-accent-rgb), 0.12);
}

.setup-field--agent {
  width: 154px;
  flex: 0 0 auto;
}

.setup-field--path {
  width: min(230px, 34vw);
  flex: 1 1 170px;
}

.setup-field input {
  width: 100%;
  height: 30px;
  min-height: 0;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.setup-field input::placeholder {
  color: var(--color-text-muted);
  font-size: 12px;
}

.setup-field input:focus {
  outline: none;
  background: transparent;
  box-shadow: none;
}

.setup-field :deep(.select-trigger) {
  height: 30px;
  min-width: 0;
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  padding: 0;
}

.setup-field :deep(.arrow-icon) {
  right: 0;
}

.setup-field :deep(.select-trigger:hover) {
  background: transparent;
}

.setup-field :deep(.select-trigger:focus),
.setup-field :deep(.select-trigger:focus-visible),
.setup-field :deep(.select-trigger[data-state='open']) {
  outline: none;
  box-shadow: none;
}

@media (max-width: 767px) {
  .session-setup-bar {
    width: 100%;
    flex-wrap: wrap;
  }

  .setup-field {
    height: 30px;
  }

  .setup-field--agent,
  .setup-field--path {
    width: auto;
    flex: 1 1 145px;
  }
}
</style>

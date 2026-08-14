<!-- eslint-disable vue/no-mutating-props -- 表单模型由父级 useAgentForm 持有，面板直接改写共享 form/tier 对象（有意的表单模型架构） -->
<template>
  <PanelFormShell title="知识库" subtitle="启用后 Agent 可使用 search_knowledge_base 工具">
    <div class="switch-list">
      <SwitchRow
        label="启用知识库检索"
        hint="启用后会向当前 Agent 暴露 search_knowledge_base 工具。"
        :checked="form.knowledge_base.enabled"
        @update:checked="form.knowledge_base.enabled = $event"
      />
    </div>

    <template v-if="form.knowledge_base.enabled">
      <FieldGroup>
        <div class="form-grid">
          <Field>
            <FieldLabel>默认集合</FieldLabel>
            <Input v-model.trim="form.knowledge_base.default_collection" type="text" placeholder="documents" />
          </Field>
          <Field>
            <FieldLabel>Top K</FieldLabel>
            <NumberInput :model-value="Number(form.knowledge_base.default_top_k) || 5" :min="1" :max="50" :step="1" @update:model-value="form.knowledge_base.default_top_k = $event" />
          </Field>
        </div>

        <Field>
          <FieldLabel>搜索模式</FieldLabel>
          <select v-model="form.knowledge_base.default_search_mode" class="form-control">
            <option v-for="mode in searchModes" :key="mode.value" :value="mode.value" :title="mode.description">{{ mode.label }}</option>
          </select>
        </Field>

        <div class="switch-list">
          <SwitchRow
            label="默认启用重排序"
            hint="对召回结果重新排序，优先保留更贴近问题的片段。"
            :checked="form.knowledge_base.default_rerank"
            @update:checked="form.knowledge_base.default_rerank = $event"
          />
        </div>

        <Field v-if="form.knowledge_base.default_rerank">
          <FieldLabel>重排序器 Key</FieldLabel>
          <Input v-model.trim="form.knowledge_base.default_reranker_key" type="text" placeholder="留空使用系统 active reranker" />
        </Field>
      </FieldGroup>
    </template>
  </PanelFormShell>
</template>

<script setup>
import { Input } from '../ui/input';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import NumberInput from '../NumberInput.vue';
import PanelFormShell from './PanelFormShell.vue';
import SwitchRow from './SwitchRow.vue';
import { knowledgeSearchModes } from './agentFormModel.js';

defineProps({
  form: { type: Object, required: true },
});

const searchModes = knowledgeSearchModes;
</script>

<style scoped>
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
</style>

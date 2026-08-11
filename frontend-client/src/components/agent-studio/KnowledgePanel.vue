<template>
  <div class="panel-form"><section class="form-section">
    <div class="section-head"><h2>知识库</h2><span>启用后 Agent 可使用 search_knowledge_base 工具</span></div>
    <div class="section-body">
      <div class="switch-list">
        <div class="switch-row">
          <div class="switch-row__copy">
            <span class="switch-row__label">启用知识库检索</span>
            <span class="switch-row__hint">启用后会向当前 Agent 暴露 search_knowledge_base 工具。</span>
          </div>
          <Switch v-model:checked="form.knowledge_base.enabled" />
        </div>
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
            <div class="switch-row">
              <div class="switch-row__copy">
                <span class="switch-row__label">默认启用重排序</span>
                <span class="switch-row__hint">对召回结果重新排序，优先保留更贴近问题的片段。</span>
              </div>
              <Switch v-model:checked="form.knowledge_base.default_rerank" />
            </div>
          </div>

          <Field v-if="form.knowledge_base.default_rerank">
            <FieldLabel>重排序器 Key</FieldLabel>
            <Input v-model.trim="form.knowledge_base.default_reranker_key" type="text" placeholder="留空使用系统 active reranker" />
          </Field>
        </FieldGroup>
      </template>
    </div>
  </section></div>
</template>

<script setup>
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import NumberInput from '../NumberInput.vue';
import { knowledgeSearchModes } from './agentFormModel.js';

defineProps({
  form: { type: Object, required: true },
});

const searchModes = knowledgeSearchModes;
</script>

<style scoped>
.form-section { gap: var(--spacing-sm); padding: 0; }
.section-head { padding-bottom: var(--spacing-sm); margin-bottom: 0; border-bottom: 1px solid var(--color-border); }
.section-head h2, .section-head h4 { font-size: var(--font-size-md); }
.section-body { gap: var(--spacing-md); }
[data-slot='field-group'] { gap: var(--spacing-md); }
.switch-list { display: flex; flex-direction: column; gap: 2px; }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: 8px 0; }
.switch-row__copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.switch-row__label { font-size: var(--font-size-sm); color: var(--color-text-primary); font-weight: 500; }
.switch-row__hint { font-size: var(--font-size-xs); color: var(--color-text-muted); line-height: 1.45; }
</style>

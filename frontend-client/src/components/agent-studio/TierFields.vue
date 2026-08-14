<!-- eslint-disable vue/no-mutating-props -- 表单模型由父级 useAgentForm 持有，面板直接改写共享 form/tier 对象（有意的表单模型架构） -->
<template>
  <div class="tier-card" :class="{ 'tier-card--on': !collapsible || enabled }">
    <div class="tier-card__head">
      <div class="tier-card__copy">
        <span class="tier-card__name">{{ title }}</span>
        <span class="tier-card__sub">{{ subtitle }}</span>
      </div>
      <Switch v-if="collapsible" :checked="enabled" @update:checked="$emit('toggle')" />
    </div>

    <div v-if="!collapsible || enabled" class="tier-card__body">
      <template v-if="tier">
        <div class="form-grid">
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <CustomSelect
              :model-value="providerKey"
              :options="providerOptions"
              placeholder="选择 Provider"
              @update:model-value="$emit('provider-change', $event)"
            />
          </Field>
          <Field>
            <FieldLabel>Provider Type</FieldLabel>
            <span class="form-static">{{ tier.provider_type || '未设置' }}</span>
          </Field>
          <Field>
            <FieldLabel>Model Name</FieldLabel>
            <CustomSelect
              :model-value="tier.model_name"
              :options="[{ value: '', label: '选择模型' }, ...modelOptions.map(m => ({ value: m, label: m }))]"
              placeholder="选择模型"
              @update:model-value="tier.model_name = $event"
            />
          </Field>
          <Field>
            <FieldLabel>Temperature</FieldLabel>
            <NumberInput :model-value="tier.temperature" :min="0" :max="2" :step="0.1" @update:model-value="tier.temperature = $event" />
          </Field>
          <Field>
            <FieldLabel>Max Completion Tokens</FieldLabel>
            <NumberInput :model-value="tier.max_completion_tokens" :min="1" :step="1" @update:model-value="tier.max_completion_tokens = $event" />
          </Field>
          <Field>
            <FieldLabel>Max Context Tokens</FieldLabel>
            <NumberInput :model-value="tier.max_context_tokens" :min="1" :step="1" @update:model-value="tier.max_context_tokens = $event" />
          </Field>
        </div>

        <div class="extra-params">
          <div class="extra-params__head">
            <span class="extra-params__label">额外参数</span>
            <Button type="button" size="sm" variant="outline" @click="addExtraParam">新增参数</Button>
          </div>
          <div v-if="tier.extra_params_entries?.length" class="extra-params__list">
            <div v-for="(entry, index) in tier.extra_params_entries" :key="`${tierName}-${index}`" class="extra-params__row">
              <Input v-model.trim="entry.key" type="text" placeholder="key" />
              <CustomSelect :model-value="entry.type" :options="extraParamTypeOptions" placeholder="type" @update:model-value="entry.type = $event" />
              <Input v-model="entry.value" type="text" placeholder="value" />
              <Button type="button" size="sm" variant="destructive" @click="removeExtraParam(index)">删除</Button>
            </div>
          </div>
          <p class="extra-params__hint">type 可选 string / number / boolean / json，json 类型的 value 需填写合法 JSON</p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
/* eslint-disable vue/no-mutating-props -- 同上：tier 为 useAgentForm 表单模型的层级子对象，脚本内改写属有意架构 */
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Field, FieldLabel } from '../ui/field';
import CustomSelect from '../ui/CustomSelect.vue';
import NumberInput from '../NumberInput.vue';
import { createExtraParamEntry } from '../../utils/modelList.js';
import { extraParamTypeOptions } from './agentFormModel.js';

const props = defineProps({
  tier: { type: Object, default: null },
  tierName: { type: String, required: true },
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  collapsible: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
  providerKey: { type: String, default: '' },
  providerOptions: { type: Array, default: () => [] },
  modelOptions: { type: Array, default: () => [] },
});

defineEmits(['provider-change', 'toggle']);

function addExtraParam() {
  if (!props.tier.extra_params_entries) props.tier.extra_params_entries = [];
  props.tier.extra_params_entries.push(createExtraParamEntry());
}
function removeExtraParam(index) {
  props.tier.extra_params_entries?.splice(index, 1);
}
</script>

<style scoped>
.tier-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
  margin-bottom: var(--spacing-md);
  overflow: hidden;
}
.tier-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 12px 14px;
}
.tier-card__copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tier-card__name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); }
.tier-card__sub { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.tier-card__body {
  padding: 14px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
.extra-params {
  padding-top: var(--spacing-sm);
  border-top: 1px dashed var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}
.extra-params__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
}
.extra-params__label { font-size: var(--font-size-sm); font-weight: 500; color: var(--color-text-secondary); }
.extra-params__list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.extra-params__row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) 120px minmax(0, 1.6fr) auto;
  gap: var(--spacing-sm);
  align-items: center;
}
.extra-params__hint { font-size: var(--font-size-xs); color: var(--color-text-muted); margin: 0; }
</style>

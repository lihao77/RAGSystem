<!-- eslint-disable vue/no-mutating-props -- modelForm 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="dialog.visible" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[520px] z-[60]">
      <DialogHeader>
        <DialogTitle>{{ dialog.mode === 'create' ? '添加模型' : '编辑模型' }}</DialogTitle>
        <DialogDescription>配置模型级运行参数与输入/输出模态；模型名可直接输入或从目录选择，同一 Provider 下不可重复。</DialogDescription>
      </DialogHeader>
      <div class="dialog-form">
        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>模型</h3><p>模型名即调用 API 时的 model 参数；Provider 厂商的目录模型自动给出建议。</p></div>
          <FieldGroup class="form-grid">
            <Field class="form-grid__full" :data-invalid="!!formErrors.name">
              <FieldLabel for="provider-model-name">模型名 <span class="required">*</span></FieldLabel>
              <ComboBox
                trigger-id="provider-model-name"
                :model-value="form.name"
                :options="catalogModelOptions"
                :placeholder="catalogModelsLoading ? '目录模型加载中...' : '输入模型名或从目录选择，如 gpt-4o / glm-5'"
                empty-text="目录无匹配模型，可继续手动输入"
                @update:model-value="form.name = $event"
                @pick="onCatalogModelPick"
              />
              <p v-if="catalogMetaText" class="provider-model-catalog__meta">{{ catalogMetaText }}</p>
              <p v-if="thinkingLevelsText" class="provider-model-catalog__meta">
                思考档位子集 {{ thinkingLevelsText }}（目录 effort 值域；仅 effort 形状生效，off 恒可用）
                <button type="button" class="provider-model-catalog__clear" @click="clearThinkingLevels">移除</button>
              </p>
              <FieldError v-if="formErrors.name">{{ formErrors.name }}</FieldError>
            </Field>
          </FieldGroup>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>运行参数</h3><p>模型级参数随模型生效；清空则调用时不指定，使用服务端默认值。</p></div>
          <FieldGroup class="form-grid">
            <Field><FieldLabel for="provider-model-temperature">温度</FieldLabel><Input id="provider-model-temperature" v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" placeholder="0.7" /></Field>
            <Field><FieldLabel for="provider-model-completion-tokens">Max Completion Tokens</FieldLabel><Input id="provider-model-completion-tokens" v-model.number="form.max_completion_tokens" type="number" step="256" min="256" placeholder="4096" /></Field>
            <Field><FieldLabel for="provider-model-context-tokens">Max Context Tokens</FieldLabel><Input id="provider-model-context-tokens" v-model.number="form.max_context_tokens" type="number" step="1024" min="1024" placeholder="128000" /></Field>
          </FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">模型能力</FieldLegend>
            <FieldGroup class="capability-fields">
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_function_calling" />
                  <FieldContent><FieldTitle>原生工具调用</FieldTitle></FieldContent>
                </FieldLabel>
              </Field>
            </FieldGroup>
            <div class="modality-field" :data-invalid="!!formErrors.input_modalities || !!formErrors.output_modalities">
              <div class="modality-field__head">输入模态 <span class="required">*</span></div>
              <div class="modality-chips" role="group" aria-label="输入模态">
                <button
                  v-for="option in modalityOptions"
                  :key="`input-${option.value}`"
                  type="button"
                  class="modality-chip"
                  :class="{ 'modality-chip--on': hasModality(form.input_modalities, option.value) }"
                  :disabled="option.value === 'text'"
                  :aria-pressed="hasModality(form.input_modalities, option.value)"
                  :title="option.value === 'text' ? '对话模型必须接受文本输入' : ''"
                  @click="toggleModality('input_modalities', option.value)"
                >{{ option.label }}</button>
              </div>
              <FieldError v-if="formErrors.input_modalities">{{ formErrors.input_modalities }}</FieldError>
            </div>
            <div class="modality-field">
              <div class="modality-field__head">输出模态 <span class="required">*</span></div>
              <div class="modality-chips" role="group" aria-label="输出模态">
                <button
                  v-for="option in modalityOptions"
                  :key="`output-${option.value}`"
                  type="button"
                  class="modality-chip"
                  :class="{ 'modality-chip--on': hasModality(form.output_modalities, option.value) }"
                  :disabled="option.value === 'text'"
                  :aria-pressed="hasModality(form.output_modalities, option.value)"
                  :title="option.value === 'text' ? '当前内核只消费文本输出' : ''"
                  @click="toggleModality('output_modalities', option.value)"
                >{{ option.label }}</button>
              </div>
              <FieldError v-if="formErrors.output_modalities">{{ formErrors.output_modalities }}</FieldError>
            </div>
          </FieldSet>
        </section>

        <FieldError v-if="dialog.error">{{ dialog.error }}</FieldError>
      </div>
      <DialogFooter class="provider-dialog-footer">
        <Button size="sm" variant="outline" @click="emit('close')">取消</Button>
        <Button class="provider-dialog-submit" size="sm" variant="default" @click="emit('submit')">{{ dialog.mode === 'create' ? '添加' : '保存' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// 模型条目弹窗：模型名 = 可输入 + 目录建议的组合框（目录模型按 Provider 厂商带出，
// 选中即自动填充参数/模态），下方为模型级运行参数与能力位（挂在模型上，Provider 只管连接）。
import { computed } from 'vue';
import ComboBox from '../ui/ComboBox.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Field, FieldContent, FieldError, FieldGroup,
  FieldLabel, FieldLegend, FieldSet, FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { MODALITY_OPTIONS, describeCatalogModel, matchCatalogModel } from '../../utils/modelCatalog.js';

const props = defineProps({
  dialog: { type: Object, required: true },
  form: { type: Object, required: true },
  formErrors: { type: Object, default: () => ({}) },
  catalogModels: { type: Array, default: () => [] },
  catalogModelsLoading: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'submit', 'catalogModelSelect']);

const modalityOptions = MODALITY_OPTIONS;

const catalogModelOptions = computed(() => props.catalogModels.map((model) => ({
  value: model.id,
  label: model.name === model.id ? model.id : `${model.name} (${model.id})`,
})));

// 手输/已选模型名与目录条目匹配时展示元信息（上限与定价）。
const catalogMetaText = computed(() => {
  const matched = matchCatalogModel(props.catalogModels, props.form.name);
  return matched ? describeCatalogModel(matched) : '';
});

// 已落盘的模型级思考档位子集（目录选中时自动带入；可移除回落格式默认档位）。
const thinkingLevelsText = computed(() => (
  Array.isArray(props.form.thinking_levels) && props.form.thinking_levels.length
    ? props.form.thinking_levels.join('/')
    : ''
));

function clearThinkingLevels() {
  // eslint-disable-next-line vue/no-mutating-props -- modelForm 为视图持有的表单模型，弹窗内改写属有意架构（同模板顶部声明）
  props.form.thinking_levels = [];
}

function onCatalogModelPick(option) {
  const model = props.catalogModels.find((item) => item.id === option.value);
  if (model) emit('catalogModelSelect', model);
}

function hasModality(value, token) {
  return Array.isArray(value) && value.includes(token);
}

function toggleModality(field, token) {
  const current = Array.isArray(props.form[field]) ? [...props.form[field]] : [];
  const index = current.indexOf(token);
  if (index >= 0) current.splice(index, 1);
  else current.push(token);
  // eslint-disable-next-line vue/no-mutating-props -- modelForm 为视图持有的表单模型，弹窗内改写属有意架构（同模板顶部声明）
  props.form[field] = current;
}
</script>

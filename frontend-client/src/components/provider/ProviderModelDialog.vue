<!-- eslint-disable vue/no-mutating-props -- modelForm 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="dialog.visible" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[520px] z-[60]">
      <DialogHeader>
        <DialogTitle>{{ dialog.mode === 'create' ? '添加模型' : '编辑模型' }}</DialogTitle>
        <DialogDescription>模型名即调用 API 时的 model 参数；可从目录选择自动填充，同一 Provider 下不可重复。</DialogDescription>
      </DialogHeader>
      <div class="dialog-form model-dialog-form">
        <Field class="model-dialog-field" :data-invalid="!!formErrors.name">
          <FieldLabel for="provider-model-name">模型 ID <span class="required">*</span></FieldLabel>
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
          <FieldError v-if="formErrors.name">{{ formErrors.name }}</FieldError>
        </Field>

        <Field>
          <FieldLabel for="provider-model-context-tokens">上下文窗口</FieldLabel>
          <Input id="provider-model-context-tokens" v-model.number="form.max_context_tokens" type="number" step="1024" min="1024" placeholder="128000" />
        </Field>

        <Field>
          <FieldLabel for="provider-model-completion-tokens">最大输出 Token</FieldLabel>
          <Input id="provider-model-completion-tokens" v-model.number="form.max_completion_tokens" type="number" step="256" min="256" placeholder="4096" />
        </Field>

        <div class="modality-field" :data-invalid="!!formErrors.input_modalities">
          <div class="modality-field__head">输入类型 <span class="required">*</span></div>
          <div class="modality-chips" role="group" aria-label="输入类型">
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
            ><span class="modality-check" aria-hidden="true"><Check :size="12" :stroke-width="3" /></span>{{ option.label }}<Lock v-if="option.value === 'text'" class="modality-lock" :size="12" /></button>
          </div>
          <FieldError v-if="formErrors.input_modalities">{{ formErrors.input_modalities }}</FieldError>
        </div>

        <div class="modality-field" :data-invalid="!!formErrors.output_modalities">
          <div class="modality-field__head">输出类型 <span class="required">*</span></div>
          <div class="modality-chips" role="group" aria-label="输出类型">
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
            ><span class="modality-check" aria-hidden="true"><Check :size="12" :stroke-width="3" /></span>{{ option.label }}<Lock v-if="option.value === 'text'" class="modality-lock" :size="12" /></button>
          </div>
          <FieldError v-if="formErrors.output_modalities">{{ formErrors.output_modalities }}</FieldError>
        </div>

        <Field orientation="horizontal">
          <FieldLabel>
            <Switch v-model:checked="form.supports_function_calling" />
            <FieldContent><FieldTitle>原生工具调用</FieldTitle></FieldContent>
          </FieldLabel>
        </Field>

        <details class="model-dialog-advanced" :open="advancedOpen || !!formErrors.thinking_kind" @toggle="onAdvancedToggle">
          <summary>
            <ChevronDown class="model-dialog-advanced__chev" :size="14" />
            高级设置
          </summary>
          <div class="model-dialog-advanced__body">
            <Field :data-invalid="!!formErrors.thinking_kind">
              <FieldLabel>思考形状 <span class="required">*</span></FieldLabel>
              <CustomSelect :model-value="form.thinking_kind || ''" :options="kindOptions" :placeholder="kindOptions.length ? '-- 请选择 --' : '-- 请先选择 Provider 的 API 格式 --'" @update:model-value="onKindChange" />
              <FieldError v-if="formErrors.thinking_kind">{{ formErrors.thinking_kind }}</FieldError>
            </Field>

            <div v-if="thinkingKindUsesLevels" class="modality-field">
              <div class="modality-field__head">思考档位（模型值域子集）</div>
              <div class="modality-chips" role="group" aria-label="思考档位">
                <button
                  v-for="option in thinkingLevelOptions"
                  :key="`level-${option.value}`"
                  type="button"
                  class="modality-chip"
                  :class="{ 'modality-chip--on': hasThinkingLevel(option.value) }"
                  :aria-pressed="hasThinkingLevel(option.value)"
                  @click="toggleThinkingLevel(option.value)"
                ><span class="modality-check" aria-hidden="true"><Check :size="12" :stroke-width="3" /></span>{{ option.label }}</button>
              </div>
            </div>

            <Field>
              <FieldLabel for="provider-model-temperature">温度</FieldLabel>
              <Input id="provider-model-temperature" v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" placeholder="0.7" />
            </Field>
          </div>
        </details>

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
// 选中即自动填充参数/模态），下方为运行参数与输入/输出类型（能力位挂在模型上）。
import { computed, ref } from 'vue';
import { Check, ChevronDown, Lock } from 'lucide-vue-next';
import ComboBox from '../ui/ComboBox.vue';
import CustomSelect from '../ui/CustomSelect.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Field, FieldContent, FieldError,
  FieldLabel, FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { MODALITY_OPTIONS, describeCatalogModel, matchCatalogModel } from '../../utils/modelCatalog.js';
import {
  THINKING_LEVEL_OPTIONS, THINKING_STRENGTH_LEVELS, normalizeThinkingLevels, thinkingKindOptions,
} from '../../utils/thinkingLevels.js';

const props = defineProps({
  dialog: { type: Object, required: true },
  form: { type: Object, required: true },
  formErrors: { type: Object, default: () => ({}) },
  /** Provider 的 API 格式：形状选项按格式能力矩阵过滤（anthropic/openai 系可选形状不同）。 */
  apiFormat: { type: String, default: '' },
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

// 思考形状选项：格式能力矩阵 ×（目录命中模型的可接受集/推荐形状——★ 标记，可改选）。
const kindOptions = computed(() => {
  const matched = matchCatalogModel(props.catalogModels, props.form.name);
  return thinkingKindOptions(
    props.apiFormat,
    matched?.accepted_thinking_kinds ?? [],
    matched?.recommended_thinking_kind ?? null,
  );
});

// 档位子集只对分级形状（effort/budget）有意义；toggle/none 切换时清空残留值域。
const thinkingKindUsesLevels = computed(() => props.form.thinking_kind === 'effort' || props.form.thinking_kind === 'budget');

// 高级设置折叠态：默认收起；必填校验失败（思考形状缺失）时强制展开，错误不藏在折叠里。
const advancedOpen = ref(false);
function onAdvancedToggle(event) {
  advancedOpen.value = event.target.open;
}

function onKindChange(value) {
  // eslint-disable-next-line vue/no-mutating-props -- modelForm 为视图持有的表单模型，弹窗内改写属有意架构（同模板顶部声明）
  props.form.thinking_kind = value;
  if (value !== 'effort' && value !== 'budget') {
    // eslint-disable-next-line vue/no-mutating-props -- 同上
    props.form.thinking_levels = [];
  }
}

// 思考档位子集编辑：全集取 THINKING_STRENGTH_LEVELS（目录 effort 值域是它的子集），选中即模型真实值域。
const thinkingLevelOptions = THINKING_STRENGTH_LEVELS
  .map((value) => THINKING_LEVEL_OPTIONS.find((option) => option.value === value))
  .filter(Boolean);

function hasThinkingLevel(token) {
  return normalizeThinkingLevels(props.form.thinking_levels).includes(token);
}

function toggleThinkingLevel(token) {
  const current = normalizeThinkingLevels(props.form.thinking_levels);
  // eslint-disable-next-line vue/no-mutating-props -- modelForm 为视图持有的表单模型，弹窗内改写属有意架构（同模板顶部声明）
  props.form.thinking_levels = current.includes(token)
    ? current.filter((item) => item !== token)
    : normalizeThinkingLevels([...current, token]);
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

<style scoped>
.model-dialog-form { gap: 16px; }
.model-dialog-field { display: flex; flex-direction: column; gap: 6px; }
/* 文本 chip 恒选锁定：右侧锁形标记 */
.modality-lock { flex-shrink: 0; color: var(--color-text-muted); }
/* 高级设置折叠：与上方内容以横线分隔（不框边），收起/展开 */
.model-dialog-advanced { border-top: 1px solid var(--color-border); }
.model-dialog-advanced summary { display: flex; align-items: center; gap: 6px; padding: 12px 2px 10px; cursor: pointer; list-style: none; font-size: var(--font-size-sm); font-weight: 500; color: var(--color-text-primary); user-select: none; }
.model-dialog-advanced summary::-webkit-details-marker { display: none; }
.model-dialog-advanced__chev { flex-shrink: 0; color: var(--color-text-secondary); transition: transform 0.2s; }
.model-dialog-advanced[open] > summary .model-dialog-advanced__chev { transform: rotate(180deg); }
.model-dialog-advanced__body { display: flex; flex-direction: column; gap: 14px; padding: 2px 2px 12px; }
@media (max-width: 640px) {
  .model-dialog-form { gap: 14px; }
}
</style>

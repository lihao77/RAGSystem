<!-- eslint-disable vue/no-mutating-props -- form/modelMapEntries 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="dialog.visible" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[720px]">
      <DialogHeader>
        <DialogTitle>{{ dialog.mode === 'create' ? '添加 Provider' : '编辑 Provider' }}</DialogTitle>
        <DialogDescription v-if="dialog.mode === 'create'">配置接入信息、运行参数和任务模型映射。</DialogDescription>
      </DialogHeader>
      <div class="dialog-form">
        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>基础配置</h3><p>填写 Provider 标识、鉴权信息与基础接入地址。</p></div>
          <FieldGroup class="form-grid">
            <Field v-if="dialog.mode === 'create'" :data-invalid="!!formErrors.name">
              <FieldLabel for="provider-name">名称 <span class="required">*</span></FieldLabel>
              <Input id="provider-name" v-model="form.name" :aria-invalid="!!formErrors.name" placeholder="例如：生产环境 OpenAI" />
              <FieldDescription>保存后生成 Key：<span class="font-mono">{{ providerKeyPreview || '填写名称并选择类型后显示' }}</span></FieldDescription>
              <FieldError v-if="formErrors.name">{{ formErrors.name }}</FieldError>
            </Field>
            <Field :data-invalid="!!formErrors.provider_type">
              <FieldLabel>Provider 类型 <span class="required">*</span></FieldLabel>
              <CustomSelect :model-value="form.provider_type" :options="providerTypeOptions" placeholder="-- 请选择 --" @update:model-value="emit('providerTypeChange', $event)" />
              <FieldError v-if="formErrors.provider_type">{{ formErrors.provider_type }}</FieldError>
            </Field>
            <Field class="form-grid__full" :data-invalid="!!formErrors.api_key">
              <FieldLabel for="provider-api-key">API Key <span v-if="dialog.mode === 'create'" class="required">*</span></FieldLabel>
              <Input id="provider-api-key" v-model="form.api_key" type="password" :aria-invalid="!!formErrors.api_key" :placeholder="dialog.mode === 'create' ? 'sk-... 或 ${ENV_VAR}' : '留空则保持当前 API Key'" autocomplete="new-password" />
              <FieldDescription>{{ dialog.mode === 'create' ? '支持 ${ENV_VAR} 形式引用环境变量；列表接口不会回传明文。' : '仅在需要替换密钥时填写；留空表示保持当前值。' }}</FieldDescription>
              <FieldError v-if="formErrors.api_key">{{ formErrors.api_key }}</FieldError>
            </Field>
            <Field class="form-grid__full" :data-invalid="!!formErrors.api_endpoint">
              <FieldLabel for="provider-api-endpoint">API Endpoint</FieldLabel>
              <Input id="provider-api-endpoint" v-model="form.api_endpoint" :aria-invalid="!!formErrors.api_endpoint" :placeholder="apiEndpointPlaceholder" />
              <FieldDescription>留空时使用该 Provider 类型的默认 Endpoint。</FieldDescription>
              <FieldError v-if="formErrors.api_endpoint">{{ formErrors.api_endpoint }}</FieldError>
            </Field>
          </FieldGroup>
        </section>

        <section v-if="form.provider_type !== 'rerank_api'" class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>运行参数</h3><p>配置温度与 token 上限等模型运行参数。</p></div>
          <FieldGroup class="form-grid">
            <Field><FieldLabel for="provider-temperature">温度</FieldLabel><Input id="provider-temperature" v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" placeholder="0.7" /></Field>
            <Field><FieldLabel for="provider-completion-tokens">Max Completion Tokens</FieldLabel><Input id="provider-completion-tokens" v-model.number="form.max_completion_tokens" type="number" step="256" min="256" placeholder="4096" /></Field>
            <Field><FieldLabel for="provider-context-tokens">Max Context Tokens</FieldLabel><Input id="provider-context-tokens" v-model.number="form.max_context_tokens" type="number" step="1024" min="1024" placeholder="128000" /></Field>
          </FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">模型能力</FieldLegend>
            <FieldGroup class="capability-fields">
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_function_calling" />
                  <FieldContent><FieldTitle>原生 Function Calling</FieldTitle><FieldDescription>OpenAI 兼容模型启用厂商原生工具调用；Anthropic 自动使用 tool_use。</FieldDescription></FieldContent>
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_vision" />
                  <FieldContent><FieldTitle>图片输入（Vision）</FieldTitle><FieldDescription>标记此 Provider 的 Chat 模型能够识别图片。</FieldDescription></FieldContent>
                </FieldLabel>
              </Field>
            </FieldGroup>
          </FieldSet>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>模型与扩展</h3><p>管理 Provider 的扩展字段与任务模型映射。</p></div>
          <template v-if="resilienceProviderConfigFields.length > 0">
            <div class="form-section-title">超时与重试</div>
            <FieldGroup class="form-grid">
              <Field v-for="field in resilienceProviderConfigFields" :key="field.key" :orientation="field.type === 'boolean' ? 'horizontal' : 'vertical'">
                <FieldLabel v-if="field.type !== 'boolean'" :for="`provider-extra-${field.key}`">{{ field.label }}</FieldLabel>
                <template v-if="field.type === 'boolean'">
                  <FieldLabel>
                    <Switch v-model:checked="form[field.key]" />
                    <FieldContent><FieldTitle>{{ field.label }}</FieldTitle><FieldDescription v-if="field.help">{{ field.help }}</FieldDescription></FieldContent>
                  </FieldLabel>
                </template>
                <CustomSelect v-else-if="field.type === 'select'" :model-value="form[field.key] ?? ''" :options="field.options || []" :placeholder="field.placeholder || '-- 请选择 --'" @update:model-value="form[field.key] = $event" />
                <Input v-else-if="field.type === 'number'" :id="`provider-extra-${field.key}`" v-model.number="form[field.key]" type="number" :step="field.step || (field.key === 'retry_delay' ? 0.1 : field.key === 'timeout' ? 5 : 1)" :min="field.min" :max="field.max" :placeholder="field.placeholder || ''" />
                <Input v-else :id="`provider-extra-${field.key}`" v-model="form[field.key]" :type="field.type === 'password' ? 'password' : 'text'" :placeholder="field.placeholder || ''" />
                <FieldDescription v-if="field.help && field.type !== 'boolean'">{{ field.help }}</FieldDescription>
              </Field>
            </FieldGroup>
          </template>
          <template v-if="extensionProviderConfigFields.length > 0">
            <div class="form-section-title">Provider 扩展配置</div>
            <FieldGroup class="form-grid">
              <Field v-for="field in extensionProviderConfigFields" :key="field.key" :orientation="field.type === 'boolean' ? 'horizontal' : 'vertical'">
                <FieldLabel v-if="field.type !== 'boolean'" :for="`provider-extra-${field.key}`">{{ field.label }}</FieldLabel>
                <template v-if="field.type === 'boolean'">
                  <FieldLabel>
                    <Switch v-model:checked="form[field.key]" />
                    <FieldContent><FieldTitle>{{ field.label }}</FieldTitle><FieldDescription v-if="field.help">{{ field.help }}</FieldDescription></FieldContent>
                  </FieldLabel>
                </template>
                <CustomSelect v-else-if="field.type === 'select'" :model-value="form[field.key] ?? ''" :options="field.options || []" :placeholder="field.placeholder || '-- 请选择 --'" @update:model-value="form[field.key] = $event" />
                <Input v-else-if="field.type === 'number'" :id="`provider-extra-${field.key}`" v-model.number="form[field.key]" type="number" :step="field.step || 1" :min="field.min" :max="field.max" :placeholder="field.placeholder || ''" />
                <Input v-else :id="`provider-extra-${field.key}`" v-model="form[field.key]" :type="field.type === 'password' ? 'password' : 'text'" :placeholder="field.placeholder || ''" />
                <FieldDescription v-if="field.help && field.type !== 'boolean'">{{ field.help }}</FieldDescription>
              </Field>
            </FieldGroup>
          </template>
          <FieldSet :data-invalid="!!formErrors.model_map">
            <FieldLegend variant="label">模型映射 (model_map)</FieldLegend>
            <FieldDescription>按 Chat、Embedding、Rerank 任务分别配置真实模型名；同一任务可添加多个模型。</FieldDescription>
            <div class="model-map-editor">
              <div v-for="(entry, idx) in modelMapEntries" :key="idx" class="model-map-row">
                <CustomSelect v-model="entry.task" :options="modelTaskOptions" placeholder="任务类型" />
                <span class="map-arrow"><IconChevronRight /></span>
                <Input v-model="entry.model" :aria-label="`${entry.task || '任务'} 模型名`" placeholder="例如：gpt-4.1" />
                <Button variant="ghost" size="icon" aria-label="删除映射" title="删除映射" :disabled="modelMapEntries.length === 1" @click="emit('removeModelMapEntry', idx)">
                  <IconClose />
                </Button>
              </div>
              <Button variant="outline" class="w-full" @click="emit('addModelMapEntry')"><IconPlus data-icon="inline-start" />添加映射</Button>
              <FieldError v-if="formErrors.model_map">{{ formErrors.model_map }}</FieldError>
            </div>
          </FieldSet>
        </section>

        <FieldError v-if="dialog.error">{{ dialog.error }}</FieldError>
      </div>
      <DialogFooter class="provider-dialog-footer">
        <Button size="sm" variant="outline" :disabled="saving" @click="emit('close')">取消</Button>
        <Button class="provider-dialog-submit" size="sm" variant="default" :disabled="saving" @click="emit('submit')"><IconRefresh v-if="saving" data-icon="inline-start" class="spin" />{{ saving ? '保存中...' : '保存' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// Provider 新建/编辑弹窗：基础配置 + 运行参数 + 扩展字段（schema 驱动）+ 模型映射。
import CustomSelect from '../ui/CustomSelect.vue';
import IconChevronRight from '../icons/IconChevronRight.vue';
import IconClose from '../icons/IconClose.vue';
import IconPlus from '../icons/IconPlus.vue';
import IconRefresh from '../icons/IconRefresh.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Field, FieldContent, FieldDescription, FieldError, FieldGroup,
  FieldLabel, FieldLegend, FieldSet, FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';

defineProps({
  dialog: { type: Object, required: true },
  form: { type: Object, required: true },
  formErrors: { type: Object, default: () => ({}) },
  providerTypeOptions: { type: Array, default: () => [] },
  apiEndpointPlaceholder: { type: String, default: '' },
  providerKeyPreview: { type: String, default: '' },
  resilienceProviderConfigFields: { type: Array, default: () => [] },
  extensionProviderConfigFields: { type: Array, default: () => [] },
  modelMapEntries: { type: Array, default: () => [] },
  modelTaskOptions: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'submit', 'providerTypeChange', 'addModelMapEntry', 'removeModelMapEntry']);
</script>

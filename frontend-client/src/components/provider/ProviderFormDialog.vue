<!-- eslint-disable vue/no-mutating-props -- form 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="dialog.visible" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[720px]">
      <DialogHeader>
        <DialogTitle>{{ dialog.mode === 'create' ? '添加 Provider' : '编辑 Provider' }}</DialogTitle>
        <DialogDescription v-if="dialog.mode === 'create'">配置接入信息与模型列表；运行参数在单个模型上配置。</DialogDescription>
      </DialogHeader>
      <div class="dialog-form">
        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>基础配置</h3><p>填写 Provider 标识、鉴权信息与基础接入地址。</p></div>
          <FieldGroup class="form-grid">
            <Field v-if="dialog.mode === 'create'" :data-invalid="!!formErrors.name">
              <FieldLabel for="provider-name">名称 <span class="required">*</span></FieldLabel>
              <Input id="provider-name" v-model="form.name" :aria-invalid="!!formErrors.name" placeholder="例如：生产环境 OpenAI" />
              <FieldDescription>保存后生成 Key：<span class="font-mono">{{ providerKeyPreview || '填写名称并填写厂商后显示' }}</span></FieldDescription>
              <FieldError v-if="formErrors.name">{{ formErrors.name }}</FieldError>
            </Field>
            <Field :data-invalid="!!formErrors.provider_type">
              <FieldLabel for="provider-vendor">厂商 <span class="required">*</span></FieldLabel>
              <ComboBox
                trigger-id="provider-vendor"
                :model-value="form.provider_type"
                :options="catalogVendorOptions"
                placeholder="输入或选择厂商，如 zhipuai / moonshotai"
                empty-text="目录无匹配厂商，可继续手动输入"
                :aria-invalid="!!formErrors.provider_type"
                @update:model-value="emit('vendorInput', $event)"
                @pick="emit('catalogVendorPick', $event.value)"
              />
              <FieldDescription>provider type 即厂商：从目录选择自动带出 API 格式与 Endpoint；自建服务直接输入标识。</FieldDescription>
              <FieldError v-if="formErrors.provider_type">{{ formErrors.provider_type }}</FieldError>
            </Field>
            <Field :data-invalid="!!formErrors.api_format">
              <FieldLabel>API 格式 <span class="required">*</span></FieldLabel>
              <CustomSelect :model-value="form.api_format" :options="apiFormatOptions" placeholder="-- 请选择 --" @update:model-value="emit('apiFormatChange', $event)" />
              <FieldDescription>核心协议家族；思考形状在下方每个模型条目上必选（目录模型自动预填推荐值）。</FieldDescription>
              <FieldError v-if="formErrors.api_format">{{ formErrors.api_format }}</FieldError>
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
              <FieldDescription>留空时使用该 API 格式的默认 Endpoint。</FieldDescription>
              <FieldError v-if="formErrors.api_endpoint">{{ formErrors.api_endpoint }}</FieldError>
            </Field>
          </FieldGroup>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head">
            <h3>模型</h3>
            <p>添加模型并逐个配置运行参数与能力位；首个模型为默认模型。</p>
          </div>
          <div class="provider-model-list">
            <div v-for="(model, idx) in modelEntries" :key="`${model.name}:${idx}`" class="provider-model-row">
              <span class="provider-model-name font-mono" :title="model.name">
                {{ model.name }}
                <span v-if="idx === 0" class="provider-model-default">默认</span>
              </span>
              <span class="provider-model-summary">{{ modelSummary(model) }}</span>
              <span class="provider-model-caps">
                <Badge v-if="model.supports_function_calling" variant="outline" :title="modelCapabilityTitle(model)">工</Badge>
                <Badge v-if="modelModalityMarks(model).length" variant="outline" :title="modelCapabilityTitle(model)">{{ modelModalityMarks(model).join(' ') }}</Badge>
              </span>
              <span class="provider-model-actions">
                <Button variant="ghost" size="icon" aria-label="上移模型" title="上移（越靠前越优先）" :disabled="idx === 0" @click="emit('moveModel', idx, -1)">
                  <ChevronUp />
                </Button>
                <Button variant="ghost" size="icon" aria-label="下移模型" title="下移" :disabled="idx === modelEntries.length - 1" @click="emit('moveModel', idx, 1)">
                  <ChevronDown />
                </Button>
                <Button variant="ghost" size="icon" aria-label="编辑模型" title="编辑模型" @click="emit('editModel', idx)">
                  <IconEdit />
                </Button>
                <Button variant="ghost" size="icon" aria-label="删除模型" title="删除模型" @click="emit('removeModel', idx)">
                  <IconClose />
                </Button>
              </span>
            </div>
            <Button variant="outline" class="w-full" @click="emit('addModel')"><IconPlus data-icon="inline-start" />添加模型</Button>
            <FieldError v-if="formErrors.models">{{ formErrors.models }}</FieldError>
          </div>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>连接与扩展</h3><p>超时重试与 Provider 级扩展配置（与具体模型无关）。</p></div>
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
// Provider 新建/编辑弹窗：基础配置（目录厂商选择即类型选择，自动切类型/填 Endpoint）
// + 模型列表（模型级参数经 ProviderModelDialog 配置）+ 扩展字段（schema 驱动）。
import CustomSelect from '../ui/CustomSelect.vue';
import ComboBox from '../ui/ComboBox.vue';
import { ChevronDown, ChevronUp } from 'lucide-vue-next';
import IconClose from '../icons/IconClose.vue';
import IconEdit from '../icons/IconEdit.vue';
import IconPlus from '../icons/IconPlus.vue';
import IconRefresh from '../icons/IconRefresh.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Field, FieldContent, FieldDescription, FieldError, FieldGroup,
  FieldLabel, FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { modelCapabilityTitle, modelModalityMarks } from '../../utils/modelCatalog.js';

defineProps({
  dialog: { type: Object, required: true },
  form: { type: Object, required: true },
  formErrors: { type: Object, default: () => ({}) },
  apiFormatOptions: { type: Array, default: () => [] },
  apiEndpointPlaceholder: { type: String, default: '' },
  providerKeyPreview: { type: String, default: '' },
  resilienceProviderConfigFields: { type: Array, default: () => [] },
  extensionProviderConfigFields: { type: Array, default: () => [] },
  modelEntries: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
  catalogVendorOptions: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'submit', 'vendorInput', 'catalogVendorPick', 'apiFormatChange', 'addModel', 'editModel', 'removeModel', 'moveModel']);

function modelSummary(model) {
  const parts = [];
  if (model.temperature !== '' && model.temperature != null) parts.push(`温度 ${model.temperature}`);
  if (model.max_completion_tokens) parts.push(`输出 ${model.max_completion_tokens}`);
  if (model.max_context_tokens) parts.push(`上下文 ${model.max_context_tokens}`);
  return parts.length ? parts.join(' · ') : '默认参数';
}
</script>
